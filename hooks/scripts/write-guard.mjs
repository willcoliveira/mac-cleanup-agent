#!/usr/bin/env node
/**
 * PreToolUse hook (matcher: Write|Edit|MultiEdit|NotebookEdit).
 * Denies edits inside mac-cleanup-agent's own state: the runs folder (scan
 * inventories, approvals, manifests) and ~/.config/mac-cleanup-agent. Approvals
 * change only through `mac-cleanup-agent approvals set|veto`, which re-validate
 * every id against the scan and keep the scan hash pin intact.
 * Fails closed on internal errors only when the target path looks like ours.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absolute, home } from './protected-roots.mjs';

const inside = (child, parent) => child === parent || child.startsWith(parent + '/');

export function checkWrite(filePath, cwd) {
  const p = absolute(filePath, cwd);
  if (inside(p, join(home(), 'Library/Application Support/mac-cleanup-agent'))) {
    return 'mac-cleanup-agent run state (scans, approvals, manifests) only changes through its CLI: approvals set / veto.';
  }
  const config = join(home(), '.config/mac-cleanup-agent');
  // rules.yaml and organize.yaml are user settings; they can only add protection, never remove it.
  if (inside(p, config) && !['rules.yaml', 'organize.yaml'].includes(p.slice(config.length + 1))) {
    return 'only rules.yaml and organize.yaml in ~/.config/mac-cleanup-agent may be edited.';
  }
  return null;
}

function main() {
  if (process.env.MCA_HOOKS === 'off') return;
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
    const input = JSON.parse(raw);
    const path = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
    if (!path) return;
    const reason = checkWrite(String(path), input.cwd);
    if (reason) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    }
  } catch (e) {
    if (raw.includes('mac-cleanup-agent')) {
      process.stderr.write(`mac-cleanup-agent write guard failed (${e?.message ?? e}); blocking.\n`);
      process.exit(2);
    }
  }
}

// Run only when executed directly (not when imported by tests). Paths may contain spaces.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main();
