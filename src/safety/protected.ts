/**
 * Protected data. Enforcement lives here, in the CLI, not in the plugin hooks:
 * the CLI runs without Claude, and hooks fail open on anything but exit 2.
 *
 * Precedence (highest first):
 *   1. HARD roots (code constants) — never offered, never unlockable.
 *   2. DEFAULT roots (code constants) — never offered unless the exact path is unlocked.
 *   3. User `protect` entries from ~/.config/mac-cleanup-agent/rules.yaml.
 * Rules can only *offer* paths outside all three. A path is also refused when it
 * CONTAINS a protected root (trashing ~/Library would take the Keychains with it).
 */
import { join } from 'node:path';
import { isInside } from '../core/util.js';

export interface ProtectionContext {
  home: string;
  trashRoot: string;
  runsDir: string;
  userProtect: string[];
  /** Exact realpaths unlocked for this run by a human. */
  unlocked: Set<string>;
}

export function hardRoots(ctx: Pick<ProtectionContext, 'home' | 'trashRoot' | 'runsDir'>): string[] {
  const h = ctx.home;
  return [
    join(h, 'Library/Keychains'),
    join(h, '.ssh'),
    join(h, '.gnupg'),
    ctx.trashRoot,
    ctx.runsDir,
    join(h, '.config/mac-cleanup-agent'),
  ];
}

export function defaultRoots(home: string): Array<{ path: string; label: string }> {
  const r = (p: string, label: string) => ({ path: join(home, p), label });
  return [
    r('Pictures/Photos Library.photoslibrary', 'Photos library'),
    r('Library/Mail', 'Mail'),
    r('Library/Messages', 'Messages'),
    r('Library/Mobile Documents', 'iCloud Drive (local copy)'),
    r('Library/CloudStorage', 'Cloud storage providers'),
    r('Library/Application Support/AddressBook', 'Contacts'),
    r('Library/Calendars', 'Calendars'),
    r('Library/Safari', 'Safari'),
    r('Library/Application Support/Google/Chrome', 'Chrome profiles (history, passwords)'),
    r('Library/Application Support/Firefox', 'Firefox profiles'),
    r('Library/Application Support/BraveSoftware', 'Brave profiles'),
    r('Library/Application Support/Microsoft Edge', 'Edge profiles'),
    r('Library/Group Containers', 'App group data'),
    r('Library/Containers/com.apple.mail', 'Mail container'),
    r('Library/Containers/com.apple.Notes', 'Notes'),
    r('Library/Application Support/MobileSync', 'iPhone/iPad backups'),
    r('Documents', 'Documents'),
    r('Desktop', 'Desktop'),
    r('Pictures', 'Pictures'),
    r('Music', 'Music'),
    r('Movies', 'Movies'),
    r('.aws', 'AWS credentials'),
    r('.kube', 'Kubernetes config'),
    r('.docker/config.json', 'Docker credentials'),
    r('.npmrc', 'npm credentials'),
    r('.netrc', 'netrc credentials'),
    r('.cache/huggingface', 'Downloaded ML models'),
  ];
}

/**
 * Whole folders like Documents and Desktop are protected as *roots*, but rules
 * may still offer specific regenerable things found inside them (node_modules,
 * test reports). Those rules opt in with `insideUserFolders: true`; everything
 * else under a default root stays protected.
 */
export const USER_FOLDER_ROOTS = new Set(['Documents', 'Desktop', 'Pictures', 'Music', 'Movies']);

export type ProtectionVerdict =
  | { protected: false }
  | { protected: true; reason: string; unlockable: boolean };

export function checkProtected(
  path: string,
  ctx: ProtectionContext,
  opts: { insideUserFolders?: boolean } = {},
): ProtectionVerdict {
  for (const root of hardRoots(ctx)) {
    if (isInside(path, root) || isInside(root, path)) {
      return { protected: true, reason: 'hard-protected location', unlockable: false };
    }
  }
  if (ctx.unlocked.has(path)) return { protected: false };
  for (const { path: root, label } of defaultRoots(ctx.home)) {
    const isUserFolder = USER_FOLDER_ROOTS.has(root.slice(ctx.home.length + 1));
    if (isInside(root, path)) return { protected: true, reason: `contains protected ${label}`, unlockable: false };
    if (isInside(path, root)) {
      if (isUserFolder && opts.insideUserFolders && path !== root) continue;
      return { protected: true, reason: `protected: ${label}`, unlockable: true };
    }
  }
  for (const root of ctx.userProtect) {
    if (isInside(path, root) || isInside(root, path)) {
      return { protected: true, reason: 'protected by your rules.yaml', unlockable: true };
    }
  }
  if (path === ctx.home || path === '/' || isInside(ctx.home, path)) {
    return { protected: true, reason: 'home or system root', unlockable: false };
  }
  return { protected: false };
}

/** Validates an `--unlock` request. Exact path only; never a parent of a protected root. */
export function validateUnlock(path: string, ctx: ProtectionContext): string | null {
  if (/[*?[\]{}]/.test(path)) return 'globs are not allowed; unlock one exact path';
  if (!path.startsWith('/')) return 'unlock needs an absolute path';
  for (const root of hardRoots(ctx)) {
    if (isInside(path, root) || isInside(root, path)) return 'this location can never be unlocked';
  }
  for (const { path: root } of defaultRoots(ctx.home)) {
    if (isInside(root, path) && root !== path) return 'cannot unlock a folder that contains a protected location';
  }
  if (path === ctx.home || isInside(ctx.home, path)) return 'cannot unlock your home folder or above';
  return null;
}
