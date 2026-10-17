/**
 * Security findings: secret-looking files left in Downloads/Desktop/Documents
 * and credential files readable by other users. The tool never reads, moves or
 * deletes these files. The only fix it can apply is tightening permissions
 * (chmod 600/700) on a regular file or folder you own, after approval.
 */
import { basename, join } from 'node:path';
import type { SecurityFinding } from './core/schemas.js';
import { displayLabel, findingId, nfc } from './core/util.js';
import type { Platform } from './platform/types.js';

const SECRET_NAME = [
  /recovery[-_ ]?codes?/i,
  /2fa[-_ ]?(recovery|backup|codes?)/i,
  /backup[-_ ]?codes?/i,
  /^client_secret.*\.json$/i,
  /\.(p12|pfx|pem|key|keystore|jks|mobileprovision)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /credentials?\.(json|csv|txt)$/i,
  /service[-_]?account.*\.json$/i,
  /^\.env(\..+)?$/,
  /seed[-_ ]?phrase/i,
];

export function isSensitiveName(path: string): boolean {
  const n = nfc(basename(path));
  return SECRET_NAME.some((r) => r.test(n));
}

/** Credential files that must not be readable by group or others. */
const CREDENTIAL_FILES = [
  '.android/adbkey',
  '.npmrc',
  '.netrc',
  '.aws/credentials',
  '.docker/config.json',
  '.kube/config',
  '.pgpass',
  '.git-credentials',
];

async function walkNames(p: Platform, root: string, maxDepth: number, visit: (path: string) => void): Promise<void> {
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    const entries = await p.readdir(dir);
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (e.kind === 'symlink') continue;
      const full = join(dir, e.name);
      if (e.kind === 'dir') {
        if (['node_modules', '.git', '.venv', 'Library', '.Trash'].includes(e.name) || e.name.endsWith('.app')) continue;
        await walk(full, depth + 1);
      } else if (e.kind === 'file') visit(full);
    }
  };
  await walk(root, 1);
}

export async function scanSecurity(p: Platform): Promise<SecurityFinding[]> {
  const out: SecurityFinding[] = [];
  const seen = new Set<string>();
  const loose = ['Downloads', 'Desktop', 'Documents'];
  for (const d of loose) {
    const hits: string[] = [];
    await walkNames(p, join(p.home, d), d === 'Documents' ? 4 : 2, (path) => {
      // .env files belong inside projects; only flag them loose in Downloads/Desktop.
      if (/^\.env/.test(basename(path)) && d === 'Documents') return;
      if (isSensitiveName(path)) hits.push(path);
    });
    for (const path of hits) {
      seen.add(path);
      out.push({
        id: findingId(path, 'secret-filename'),
        kind: /\.(p12|pfx|pem|key|keystore|jks)$|^id_/i.test(basename(path)) ? 'key-file' : 'secret-filename',
        label: displayLabel(path, p.home),
        path,
        advice: 'Looks like a secret or key. Store it in a password manager or Keychain, then delete the loose copy yourself.',
      });
    }
  }
  const sshDir = join(p.home, '.ssh');
  const ssh = await p.readdir(sshDir);
  const candidates = [...CREDENTIAL_FILES.map((f) => join(p.home, f))];
  if (Array.isArray(ssh)) {
    for (const e of ssh) if (e.kind === 'file' && !e.name.endsWith('.pub') && !['known_hosts', 'config', 'authorized_keys'].includes(e.name) && !e.name.startsWith('known_hosts')) candidates.push(join(sshDir, e.name));
  }
  for (const path of candidates) {
    if (seen.has(path)) continue;
    const s = await p.lstat(path);
    if (!s || s.kind !== 'file' || s.uid !== p.uid) continue;
    if ((s.mode & 0o077) === 0) continue;
    out.push({
      id: findingId(path, 'loose-permissions'),
      kind: 'loose-permissions',
      label: displayLabel(path, p.home),
      path,
      mode: s.mode.toString(8).padStart(3, '0'),
      advice: `Readable by other users (mode ${s.mode.toString(8)}). Tighten it to 600.`,
      fix: { type: 'chmod', mode: '600' },
    });
  }
  return out;
}

/**
 * Applies one approved chmod fix. Re-checks everything at the moment of change:
 * regular file (never a symlink), owned by the user, and the new mode is
 * strictly tighter. Never recursive, never chown.
 */
export async function applyChmodFix(p: Platform, finding: SecurityFinding): Promise<string> {
  if (!finding.fix) throw new Error('this finding has no automatic fix');
  const s = await p.lstat(finding.path);
  if (!s) throw new Error('the file no longer exists');
  if (s.kind !== 'file' && s.kind !== 'dir') throw new Error('refusing: not a regular file or folder (symlinks are never changed)');
  if (s.uid !== p.uid) throw new Error('refusing: you do not own this file');
  const target = Number.parseInt(finding.fix.mode, 8);
  if ((s.mode & ~target & 0o777) === 0 && (target & ~s.mode & 0o777) === 0) return 'already tight';
  if ((target & ~s.mode & 0o777) !== 0) throw new Error('refusing: the fix would loosen permissions');
  await p.chmod(finding.path, target);
  return `mode ${s.mode.toString(8)} → ${finding.fix.mode}`;
}
