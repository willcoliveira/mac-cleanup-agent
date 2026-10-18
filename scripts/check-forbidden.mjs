#!/usr/bin/env node
// Fails when any forbidden string appears in tracked files (and, with --history,
// in any commit, message or tag of the repository). The real list lives OUTSIDE
// the repo — ~/.config/mac-cleanup-agent/forbidden-strings.txt or the path in
// FORBIDDEN_STRINGS_FILE — because it holds the very names it protects. CI runs
// with privacy/forbidden-strings.example.txt, which only holds placeholders.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The placeholder list is skipped: it would always match itself.
const EXAMPLE = 'privacy/forbidden-strings.example.txt';
const candidates = [
  process.env.FORBIDDEN_STRINGS_FILE,
  join(homedir(), '.config/mac-cleanup-agent/forbidden-strings.txt'),
  join(root, EXAMPLE),
]
  .filter(Boolean)
  .map((p) => resolve(p));
const listPath = candidates.find((p) => existsSync(p));
if (!listPath) {
  console.error('check-forbidden: no list found');
  process.exit(2);
}
const terms = readFileSync(listPath, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = new RegExp(`(?<![A-Za-z0-9])(${terms.map(escape).join('|')})(?![A-Za-z0-9])`, 'i');

const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const hits = [];
const files = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
for (const f of files) {
  if (f === 'package-lock.json' || f.startsWith('site/package-lock.json') || f === EXAMPLE) continue;
  const path = join(root, f);
  if (!existsSync(path)) continue;
  if (pattern.test(f)) hits.push(`${f}: (file name)`);
  const text = readFileSync(path, 'utf8');
  text.split('\n').forEach((line, i) => {
    const m = line.match(pattern);
    if (m) hits.push(`${f}:${i + 1}: "${m[1]}"`);
  });
}
if (process.argv.includes('--history')) {
  let log = '';
  try {
    log = git('log', '--all', '-p', '--format=commit %H%n%an <%ae>%n%B');
  } catch {
    log = '';
  }
  let inExample = false;
  log.split('\n').forEach((line) => {
    if (line.startsWith('commit ')) {
      inExample = false;
      return;
    }
    if (line.startsWith('diff --git ')) inExample = line === `diff --git a/${EXAMPLE} b/${EXAMPLE}`;
    if (inExample) return;
    const m = line.match(pattern);
    if (m) hits.push(`history: "${m[1]}" in: ${line.slice(0, 80)}`);
  });
  try {
    const tags = git('tag', '-n99');
    if (pattern.test(tags)) hits.push('history: a tag message');
  } catch {
    /* no tags */
  }
}
if (hits.length) {
  console.error(`check-forbidden: ${hits.length} hit(s) using ${listPath === join(root, EXAMPLE) ? 'the example list' : 'your private list'}:`);
  for (const h of hits.slice(0, 50)) console.error('  ' + h);
  process.exit(1);
}
console.log(`check-forbidden: clean (${terms.length} term(s), ${files.length} file(s)${process.argv.includes('--history') ? ', full history' : ''})`);
