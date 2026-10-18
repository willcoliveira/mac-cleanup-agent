import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CONTRACT_VERSION } from '../../src/core/schemas.js';
import { defaultRoots, hardRoots } from '../../src/safety/protected.js';
// @ts-expect-error plain .mjs hook modules (Node built-ins only)
import { DEFAULT_REL, HARD_REL } from '../../hooks/scripts/protected-roots.mjs';
// @ts-expect-error plain .mjs hook modules
import { checkCommand } from '../../hooks/scripts/bash-guard.mjs';
// @ts-expect-error plain .mjs hook modules
import { checkWrite } from '../../hooks/scripts/write-guard.mjs';

const ROOT = resolve(process.cwd());

function frontmatter(path: string): Record<string, unknown> {
  const m = readFileSync(path, 'utf8').match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`no frontmatter in ${path}`);
  return parse(m[1] as string) as Record<string, unknown>;
}

describe('agents', () => {
  const dir = join(ROOT, '.claude/agents');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  const ALLOWED = new Set(['name', 'description', 'tools', 'model', 'effort', 'maxTurns']);
  it.each(files)('%s has valid frontmatter and narrow tools', (f) => {
    const fm = frontmatter(join(dir, f));
    expect(fm.name).toBe(f.replace(/\.md$/, ''));
    expect(String(fm.name)).toMatch(/^mca-[a-z-]+-agent$/);
    for (const k of Object.keys(fm)) expect(ALLOWED.has(k)).toBe(true);
    expect(['haiku', 'sonnet', 'opus', 'fable', 'inherit']).toContain(fm.model);
    expect(String(fm.description).length).toBeLessThanOrEqual(1024);
    const tools = String(fm.tools);
    // Every Bash grant is prefixed to the CLI; no raw Bash, no Write or Edit anywhere.
    expect(tools).not.toMatch(/(^|,\s*)Bash(\s*,|$)/);
    expect(tools).not.toMatch(/\b(Write|Edit|MultiEdit)\b/);
    for (const m of tools.matchAll(/Bash\(([^)]*)\)/g)) expect(m[1]).toMatch(/^mac-cleanup-agent [a-z]+( [a-z]+)?:\*$/);
  });
  it('indexers and analysts cannot read files', () => {
    for (const f of ['mca-area-indexer-agent.md', 'mca-area-analyst-agent.md']) expect(String(frontmatter(join(dir, f)).tools)).not.toMatch(/\bRead\b/);
  });
  it('the judge can only show and veto', () => {
    expect(String(frontmatter(join(dir, 'mca-risk-judge-agent.md')).tools)).toBe('Bash(mac-cleanup-agent approvals show:*), Bash(mac-cleanup-agent approvals veto:*)');
  });
});

describe('skills', () => {
  const dir = join(ROOT, '.claude/skills');
  const skills = readdirSync(dir);
  it.each(skills)('%s has valid frontmatter, stays short and links resolve', (s) => {
    const path = join(dir, s, 'SKILL.md');
    const fm = frontmatter(path);
    expect(fm.name).toBe(s);
    expect(String(fm.description)).toMatch(/Use when user says:/);
    expect(String(fm['allowed-tools'])).not.toMatch(/(^|,\s*)Bash(\s*,|$)/);
    const text = readFileSync(path, 'utf8');
    expect(text.split('\n').length).toBeLessThanOrEqual(500);
    for (const m of text.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([^`\s)]+)/g)) expect(existsSync(join(dir, s, m[1] as string))).toBe(true);
  });
  it('pins the contract version the CLI writes', () => {
    const contract = readFileSync(join(dir, 'cleanup/references/output-contract.md'), 'utf8');
    expect(contract).toContain(`contract_version: ${CONTRACT_VERSION})`);
    expect(readFileSync(join(dir, 'cleanup/SKILL.md'), 'utf8')).toContain(`is **${CONTRACT_VERSION}**`);
  });
});

describe('manifests', () => {
  it('keeps package, plugin and marketplace versions in sync', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8'));
    const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
    expect(plugin.version).toBe(pkg.version);
    expect(market.plugins[0].version).toBe(pkg.version);
    expect(plugin.name).toBe('mac-cleanup-agent');
  });
  it('the bin shim pins the exact version and never runs install scripts', () => {
    const shim = readFileSync(join(ROOT, 'bin/mac-cleanup-agent'), 'utf8');
    expect(shim).toContain('mac-cleanup-agent@$VER');
    expect(shim).toContain('npm_config_ignore_scripts=true');
    expect(shim).not.toContain('@latest');
  });
});

describe('hook guards', () => {
  const h = '/Users/sample';
  process.env.MCA_HOOK_HOME = h;
  const check = (cmd: string, mode?: string) => checkCommand(cmd, { cwd: `${h}/Documents/app`, permissionMode: mode }) as string | null;

  it('mirror the CLI protected roots exactly', () => {
    const ctx = { home: h, trashRoot: `${h}/.Trash`, runsDir: `${h}/Library/Application Support/mac-cleanup-agent/runs` };
    const hard = hardRoots(ctx).map((p) => p.slice(h.length + 1));
    expect(new Set(HARD_REL.map((r: string) => r))).toEqual(new Set([...hard.filter((r) => !r.startsWith('Library/Application Support/mac-cleanup-agent')), 'Library/Application Support/mac-cleanup-agent']));
    expect(DEFAULT_REL).toEqual(defaultRoots(h).map((r) => r.path.slice(h.length + 1)));
  });

  it('deny deletes of protected data, however they are spelled', () => {
    for (const cmd of [
      'rm -rf ~/Library/Keychains',
      'rm -rf ~/Library',
      'cd /tmp && rm -r "$HOME/.ssh"',
      'find ~/Pictures/Photos\\ Library.photoslibrary -delete',
      'bash -c "rm -rf ~/Library/Mail"',
      'echo $(rm -rf ~/Library/Messages)',
      'trash ~/Documents',
      'rm -rf ~',
      'xargs rm -rf ~/.gnupg',
    ]) expect(check(cmd), cmd).toMatch(/^deny:/);
  });

  it('deny sudo, osascript and inline interpreters', () => {
    for (const cmd of ['sudo rm -rf /tmp/x', 'osascript -e "tell app \\"Finder\\" to empty trash"', 'python3 -c "import shutil"', 'node -e "1"']) expect(check(cmd), cmd).toMatch(/^deny:/);
  });

  it('ask before destructive CLI and tool commands, and deny human gates when bypassed', () => {
    expect(check('mac-cleanup-agent clean --run scan_x --yes')).toMatch(/^ask:/);
    expect(check('mac-cleanup-agent empty --run scan_x --yes')).toMatch(/^ask:/);
    expect(check('mac-cleanup-agent empty --run scan_x --yes', 'bypassPermissions')).toMatch(/^deny:/);
    expect(check('mac-cleanup-agent unlock /x', 'bypassPermissions')).toMatch(/^deny:/);
    expect(check('docker system prune -a')).toMatch(/^ask:/);
    expect(check('xcrun simctl delete all')).toMatch(/^ask:/);
  });

  it('leave ordinary work alone', () => {
    for (const cmd of ['ls -la', 'rm -rf node_modules', 'rm -rf ~/Documents/app/dist', 'git status', 'mac-cleanup-agent scan --summary', 'mac-cleanup-agent clean --run scan_x']) expect(check(cmd), cmd).toBeNull();
  });

  it('deny every delete while a live cleanup run holds the lock, but ignore a stale lock', () => {
    const home = mkdtempSync(join(tmpdir(), 'mca-hook-'));
    process.env.MCA_HOOK_HOME = home;
    const runs = join(home, 'Library/Application Support/mac-cleanup-agent/runs');
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, '.lock'), String(process.pid));
    expect(checkCommand('rm -rf build', { cwd: home })).toMatch(/^deny:.*in progress/);
    // A run killed with Ctrl-C leaves its pid behind; a dead pid must not block the user's work.
    writeFileSync(join(runs, '.lock'), '999999');
    expect(checkCommand('rm -rf build', { cwd: home })).toBeNull();
    rmSync(home, { recursive: true, force: true });
    process.env.MCA_HOOK_HOME = h;
  });

  it('block on hook failure or timeout', () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8'));
    for (const entry of hooks.hooks.PreToolUse) for (const hk of entry.hooks) expect(hk.onFailure).toBe('block');
  });

  it('deny edits of the tool’s own state', () => {
    expect(checkWrite(`${h}/Library/Application Support/mac-cleanup-agent/runs/scan_x/approvals.yaml`, '/')).toMatch(/only changes through its CLI/);
    expect(checkWrite(`${h}/Documents/app/README.md`, '/')).toBeNull();
    expect(checkWrite(`${h}/.config/mac-cleanup-agent/rules.yaml`, '/')).toBeNull();
    expect(checkWrite(`${h}/.config/mac-cleanup-agent/forbidden-strings.txt`, '/')).toMatch(/may be edited/);
  });

  it('fail closed on malformed input that looks destructive, and run as a real hook', () => {
    const script = join(ROOT, 'hooks/scripts/bash-guard.mjs');
    const run = (input: string) => {
      try {
        return { out: execFileSync('node', [script], { input, encoding: 'utf8', env: { ...process.env, MCA_HOOK_HOME: h } }), code: 0 };
      } catch (e) {
        return { out: '', code: (e as { status: number }).status };
      }
    };
    expect(run('{not json, rm -rf ~').code).toBe(2);
    expect(run('{not json, ls').code).toBe(0);
    expect(JSON.parse(run(JSON.stringify({ tool_input: { command: 'rm -rf ~/.ssh' }, cwd: '/' })).out).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
