#!/usr/bin/env node
/**
 * PreToolUse hook (matcher: Bash). A second safety layer; the CLI's own
 * safety module is the first and works without Claude.
 *
 * deny  - deletes (rm, rmdir, unlink, trash, srm, find -delete, mv into the Trash)
 *         that touch a protected location (Keychains, ~/.ssh, Photos, Mail, ...)
 * deny  - ANY delete while a mac-cleanup-agent run holds its lock
 * deny  - sudo, osascript, swift, and inline interpreters (python -c, node -e, ...)
 *         inside a cleanup session: they can bypass every check above
 * ask   - mac-cleanup-agent clean --yes / empty / unlock / security --fix, and
 *         tool-native destroyers (docker prune / volume rm, simctl delete,
 *         avdmanager delete): a human answers Claude Code's permission dialog
 * deny  - the human-only gates (empty, unlock) when permissions are bypassed
 *
 * Compound commands are split on && || ; | & and newlines; env/command/exec/
 * time/nohup wrappers are skipped; bash/sh/zsh -c bodies, eval, $(...) and
 * backticks are inspected as nested commands. A deny anywhere wins.
 *
 * Fails closed: if this script errors on a command that contains a destructive
 * token, it blocks (exit 2). Otherwise an internal error lets the command
 * through to the normal permission flow, so unrelated work is never broken.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absolute, isProtectedPath, runsDir } from './protected-roots.mjs';

const WRAPPERS = new Set(['env', 'command', 'exec', 'time', 'nohup', 'caffeinate']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish']);
const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'trash', 'srm', 'shred']);
const INTERPRETERS = { python: ['-c'], python3: ['-c'], node: ['-e', '--eval', '-p', '--print'], perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'] };
const DESTRUCTIVE_TOKEN = /\b(rm|rmdir|unlink|trash|srm|shred|delete|prune|-delete|empty|mv)\b/;
const MAX_DEPTH = 4;

function decide(permissionDecision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason } }));
}

/** Splits a command line into word lists. Honours quotes and backslash escapes. */
export function segments(command) {
  const out = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quote = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (c === ';' || c === '|' || c === '&' || c === '\n') {
      endSegment();
    } else if (c === ' ' || c === '\t' || c === '(' || c === ')' || c === '{' || c === '}') {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return out;
}

function substitutions(command) {
  const found = [];
  for (const m of command.matchAll(/\$\(([^()]*)\)/g)) found.push(m[1]);
  for (const m of command.matchAll(/`([^`]*)`/g)) found.push(m[1]);
  return found;
}

const base = (w) => w.split('/').pop();

function lockHeld() {
  return existsSync(join(runsDir(), '.lock'));
}

/** Returns 'deny:<reason>', 'ask:<reason>' or null for one segment. */
function checkWords(words, ctx, depth) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  while (i < words.length && WRAPPERS.has(base(words[i]))) {
    i++;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || words[i].startsWith('-'))) i++;
  }
  if (i >= words.length) return null;
  const program = base(words[i]);
  const rest = words.slice(i + 1);
  const paths = rest.filter((w) => !w.startsWith('-')).map((w) => absolute(w, ctx.cwd));

  if (program === 'sudo' || program === 'doas') return 'deny:mac-cleanup-agent never needs root; sudo is blocked while the plugin is enabled.';
  if (program === 'osascript' || program === 'swift' || program === 'swiftc') return 'deny:osascript/swift can delete files outside every check; use the mac-cleanup-agent CLI.';
  if (INTERPRETERS[program] && rest.some((w) => INTERPRETERS[program].includes(w))) return `deny:inline ${program} code is blocked while the plugin is enabled; use the mac-cleanup-agent CLI.`;
  if (SHELLS.has(program) || program === 'eval') {
    const k = rest.indexOf('-c');
    const body = program === 'eval' ? rest.join(' ') : k >= 0 ? rest[k + 1] : null;
    if (body && depth < MAX_DEPTH) return checkCommand(body, ctx, depth + 1);
    return null;
  }
  if (program === 'xargs') return checkWords(rest.filter((w) => !w.startsWith('-')), ctx, depth + 1);

  const deleting =
    DELETERS.has(program) ||
    (program === 'find' && rest.some((w) => w === '-delete' || ((w === '-exec' || w === '-execdir') && rest.some((x) => DELETERS.has(base(x)))))) ||
    (program === 'mv' && paths.some((p) => p.includes('/.Trash')));
  if (deleting) {
    if (paths.some((p) => isProtectedPath(p))) return 'deny:this would delete a protected location (personal data, keys or the Trash itself).';
    if (lockHeld()) return 'deny:a mac-cleanup-agent run is in progress; deletes go through the CLI only until it finishes.';
    if (program === 'find' && paths.length === 0) return 'deny:find -delete without an explicit starting folder is blocked.';
    return null;
  }

  if (program === 'mac-cleanup-agent') {
    const sub = rest[0];
    const gate = sub === 'empty' || sub === 'unlock';
    if (gate && ctx.permissionMode === 'bypassPermissions') return 'deny:emptying the Trash and unlocking protected data need a human decision; they are blocked while permissions are bypassed.';
    if (sub === 'empty') return 'ask:Permanently delete the items this run moved to the Trash? Other things in your Trash are not touched. This cannot be undone.';
    if (sub === 'unlock') return 'ask:Unlock a protected location for one scan?';
    if (sub === 'clean' && rest.includes('--yes')) return 'ask:Move the approved items to the Trash?';
    if (sub === 'security' && rest.includes('--fix')) return 'ask:Tighten the permissions of this file?';
    return null;
  }
  if (program === 'docker' && (rest.includes('prune') || (rest[0] === 'volume' && rest[1] === 'rm') || rest[0] === 'rmi')) return 'ask:This permanently removes Docker data.';
  if (program === 'xcrun' && rest[0] === 'simctl' && ['delete', 'erase'].includes(rest[1] ?? '')) return 'ask:This permanently removes simulator data.';
  if (program === 'xcrun' && rest[0] === 'simctl' && rest[1] === 'runtime' && rest[2] === 'delete') return 'ask:This removes a simulator runtime.';
  if (program === 'avdmanager' && rest[0] === 'delete') return 'ask:This permanently removes an Android emulator.';
  return null;
}

export function checkCommand(command, ctx, depth = 0) {
  let ask = null;
  for (const words of segments(command)) {
    const r = checkWords(words, ctx, depth);
    if (r?.startsWith('deny:')) return r;
    if (r?.startsWith('ask:') && !ask) ask = r;
  }
  for (const sub of substitutions(command)) {
    if (depth >= MAX_DEPTH) break;
    const r = checkCommand(sub, ctx, depth + 1);
    if (r?.startsWith('deny:')) return r;
    if (r?.startsWith('ask:') && !ask) ask = r;
  }
  return ask;
}

/** Remembers which transcript drives a run, for the per-phase cost estimate. */
function recordSession(command, input) {
  const m = command.match(/\bmac-cleanup-agent\b[^\n]*--run[ =](scan_[0-9]{8}T[0-9]{6}_[a-f0-9]{6})/);
  if (!m || !input.transcript_path) return;
  const dir = join(runsDir(), m[1]);
  if (!existsSync(dir)) return;
  const file = join(dir, 'session.json');
  if (existsSync(file)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ session_id: input.session_id, transcript_path: input.transcript_path }), { mode: 0o600 });
}

function main() {
  if (process.env.MCA_HOOKS === 'off') return;
  let command = '';
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
    const input = JSON.parse(raw);
    command = String(input?.tool_input?.command ?? '');
    if (!command) return;
    const r = checkCommand(command, { cwd: input.cwd, permissionMode: input.permission_mode });
    try {
      recordSession(command, input);
    } catch {
      /* cost tracking is best-effort */
    }
    if (r) decide(r.startsWith('deny:') ? 'deny' : 'ask', r.slice(r.indexOf(':') + 1));
  } catch (e) {
    // Judge the raw input too: a parse failure means `command` was never extracted.
    if (DESTRUCTIVE_TOKEN.test(command) || DESTRUCTIVE_TOKEN.test(raw)) {
      process.stderr.write(`mac-cleanup-agent guard failed (${e?.message ?? e}); blocking a command that may delete files.\n`);
      process.exit(2);
    }
  }
}

// Run only when executed directly (not when imported by tests). Paths may contain spaces.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main();
