// Protected locations, mirrored from src/safety/protected.ts for the hooks
// (a git-sourced plugin install has no dist/ and no node_modules, so the hooks
// use Node built-ins only). tests/unit/hooks.test.ts asserts the two lists match.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HARD_REL = ['Library/Keychains', '.ssh', '.gnupg', '.Trash', 'Library/Application Support/mac-cleanup-agent', '.config/mac-cleanup-agent'];

export const DEFAULT_REL = [
  'Pictures/Photos Library.photoslibrary',
  'Library/Mail',
  'Library/Messages',
  'Library/Mobile Documents',
  'Library/CloudStorage',
  'Library/Application Support/AddressBook',
  'Library/Calendars',
  'Library/Safari',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Firefox',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Microsoft Edge',
  'Library/Group Containers',
  'Library/Containers/com.apple.mail',
  'Library/Containers/com.apple.Notes',
  'Library/Application Support/MobileSync',
  'Documents',
  'Desktop',
  'Pictures',
  'Music',
  'Movies',
  '.aws',
  '.kube',
  '.docker/config.json',
  '.npmrc',
  '.netrc',
  '.cache/huggingface',
];

export function home() {
  return process.env.MCA_HOOK_HOME || homedir();
}

export function runsDir() {
  return join(home(), 'Library/Application Support/mac-cleanup-agent/runs');
}

const inside = (child, parent) => child === parent || child.startsWith(parent + '/');

/** Expands ~ and resolves a word to an absolute path (relative to cwd). */
export function absolute(word, cwd) {
  let w = word;
  if (w === '~') w = home();
  else if (w.startsWith('~/')) w = home() + w.slice(1);
  else if (w.startsWith('$HOME/')) w = home() + w.slice(5);
  if (!w.startsWith('/')) w = join(cwd || process.cwd(), w);
  return w.replace(/\/+$/, '') || '/';
}

/**
 * True when deleting `path` would destroy protected data: the path is inside a
 * protected root, or it CONTAINS one (deleting ~/Library takes the Keychains).
 * Regenerable things inside Documents/Desktop are left to the normal permission flow.
 */
export function isProtectedPath(path) {
  const h = home();
  if (path === '/' || path === h || inside(h, path)) return true;
  for (const rel of HARD_REL) {
    const root = join(h, rel);
    if (inside(path, root) || inside(root, path)) return true;
  }
  for (const rel of DEFAULT_REL) {
    const root = join(h, rel);
    if (inside(root, path)) return true;
    if (path === root) return true;
    const userFolder = ['Documents', 'Desktop', 'Pictures', 'Music', 'Movies'].includes(rel);
    if (!userFolder && inside(path, root)) return true;
  }
  return false;
}
