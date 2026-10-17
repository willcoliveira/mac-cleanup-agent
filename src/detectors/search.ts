/**
 * Generic "find folders named X under these roots" search, plus the helpers the
 * file detectors share. Symlinks are never followed; Library, the Trash and the
 * big home-level tool folders (handled by their own rules) are never descended.
 */
import { basename, dirname, join } from 'node:path';
import type { Identity } from '../core/schemas.js';
import { expandHome } from '../core/util.js';
import type { FileStat, Platform } from '../platform/types.js';
import type { Rule } from '../rules/schema.js';
import { checkProtected } from '../safety/protected.js';
import type { Candidate, DetectorContext } from './types.js';

/** Home-level folders the generic search never walks into. */
const HOME_SKIP = new Set([
  'Library', '.Trash', 'Applications', 'Pictures', 'Music', '.npm', '.nvm', '.cache', '.gradle', '.android',
  '.docker', '.vscode', '.local', '.cocoapods', '.pyenv', '.rustup', '.cargo', 'go', '.m2', '.config', '.ssh', '.gnupg',
]);
/** Folders never descended anywhere: dependency trees and VCS internals. */
const NEVER_DESCEND = new Set(['node_modules', '.git', 'Pods', 'DerivedData', '.venv', 'venv', '.next', '.Trash']);

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

export function matchesAny(name: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(name));
}

export function identityOf(s: FileStat, bytes: number): Identity {
  return { kind: s.kind === 'dir' ? 'dir' : 'file', dev: s.dev, ino: s.ino, size: bytes, mtimeMs: Math.floor(s.mtimeMs) };
}

/** Candidate for an explicit path, or null when it doesn't exist or is a symlink. */
export async function pathCandidate(p: Platform, path: string): Promise<Candidate | null> {
  const s = await p.lstat(path);
  if (!s || s.kind === 'symlink' || s.kind === 'other') return null;
  const bytes = s.kind === 'dir' ? (await p.usage(path)).bytes : s.allocated;
  return { path, bytes, identity: identityOf(s, bytes) };
}

interface RepoState {
  root: string;
  clean: boolean;
  pushed: boolean;
}

const repoCache = new Map<string, RepoState | null>();

export function resetRepoCache(): void {
  repoCache.clear();
}

async function findRepoRoot(p: Platform, start: string): Promise<string | null> {
  let dir = start;
  while (dir.startsWith(p.home) && dir !== p.home) {
    if (await p.lstat(join(dir, '.git'))) return dir;
    dir = dirname(dir);
  }
  return null;
}

async function repoState(p: Platform, root: string): Promise<RepoState> {
  const cached = repoCache.get(root);
  if (cached) return cached;
  const status = await p.exec('git', ['-C', root, 'status', '--porcelain']);
  const ahead = await p.exec('git', ['-C', root, 'rev-list', '--count', '@{u}..HEAD']);
  const state = {
    root,
    clean: status.code === 0 && status.stdout.trim() === '',
    pushed: ahead.code === 0 && ahead.stdout.trim() === '0',
  };
  repoCache.set(root, state);
  return state;
}

/** Applies the rule's git policy. Returns a skip reason, or null to keep the candidate. */
export async function gitPolicy(p: Platform, path: string, policy: 'any' | 'ignored' | 'clean-pushed'): Promise<{ skip: string | null; note?: string }> {
  if (policy === 'any') return { skip: null };
  const root = await findRepoRoot(p, dirname(path));
  if (!root) return { skip: null, note: 'Not inside a git repository.' };
  const rel = path.slice(root.length + 1);
  const ignored = await p.exec('git', ['-C', root, 'check-ignore', '-q', '--', rel]);
  if (ignored.code !== 0) return { skip: 'tracked by git (not ignored)' };
  if (policy === 'clean-pushed') {
    const st = await repoState(p, root);
    if (!st.clean) return { skip: 'repository has uncommitted changes' };
    if (!st.pushed) return { skip: 'repository has unpushed commits or no upstream' };
  }
  return { skip: null };
}

export async function searchCandidates(ctx: DetectorContext): Promise<Candidate[]> {
  const { p, rule } = ctx;
  if (!('search' in rule.find)) return [];
  const s = rule.find.search;
  const out: Candidate[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > s.maxDepth) return;
    const entries = await p.readdir(dir);
    if (!entries || entries === 'denied') return;
    const names = entries.map((e) => e.name);
    for (const e of entries) {
      if (e.kind === 'symlink') continue;
      const full = join(dir, e.name);
      const wantKind = s.kind === 'dir' ? e.kind === 'dir' : e.kind === 'file';
      if (wantKind && matchesAny(e.name, s.names)) {
        if (s.requireSibling.length && !names.some((n) => n !== e.name && matchesAny(n, s.requireSibling))) continue;
        const verdict = checkProtected(full, ctx.protection, { insideUserFolders: rule.insideUserFolders });
        if (verdict.protected) continue;
        const git = await gitPolicy(p, full, s.git);
        if (git.skip) continue;
        const c = await pathCandidate(p, full);
        if (c) out.push(git.note ? { ...c, notes: [git.note] } : c);
        continue; // never descend into a match
      }
      if (e.kind !== 'dir') continue;
      if (dir === p.home && HOME_SKIP.has(e.name)) continue;
      if (NEVER_DESCEND.has(e.name)) continue;
      // App bundles and Photos libraries are opaque; Final Cut libraries (.fcpbundle) are walked for render files.
      if (e.name.endsWith('.app') || e.name.endsWith('.photoslibrary')) continue;
      await walk(full, depth + 1);
    }
  };
  for (const root of s.roots) await walk(expandHome(root, p.home), 1);
  return out;
}

/** Top-level files of a folder (no recursion), skipping symlinks. */
export async function topFiles(p: Platform, dir: string): Promise<Array<{ path: string; name: string; stat: FileStat }>> {
  const entries = await p.readdir(dir);
  if (!entries || entries === 'denied') return [];
  const out: Array<{ path: string; name: string; stat: FileStat }> = [];
  for (const e of entries) {
    if (e.kind !== 'file') continue;
    const full = join(dir, e.name);
    const stat = await p.lstat(full);
    if (stat && stat.kind === 'file') out.push({ path: full, name: e.name, stat });
  }
  return out;
}

export function stem(name: string): string {
  const b = basename(name);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}
