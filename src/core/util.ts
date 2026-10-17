import { createHash, randomBytes } from 'node:crypto';

/** Stable opaque id for an inventory item: same path + identity → same id within a scan. */
export function itemId(path: string, dev: number, ino: number, salt: string): string {
  return 'i_' + createHash('sha256').update(`${salt}\0${path}\0${dev}\0${ino}`).digest('hex').slice(0, 12);
}

export function findingId(path: string, kind: string): string {
  return 's_' + createHash('sha256').update(`${kind}\0${path}`).digest('hex').slice(0, 12);
}

export function newScanId(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `scan_${stamp}_${randomBytes(3).toString('hex')}`;
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Decimal units, like Finder and `df -H`: 1 GB = 1,000,000,000 bytes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = -1;
  do {
    v /= 1000;
    u++;
  } while (v >= 1000 && u < units.length - 1);
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}

export function parseSize(text: string): number {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
  if (!m) throw new Error(`invalid size "${text}" (use e.g. 50MB, 1.5GB)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'B').toUpperCase();
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[unit] ?? 1;
  return Math.round(n * mult);
}

/** NFC: macOS stores names decomposed ("ç" as c + combining cedilla); match on composed text. */
export function nfc(s: string): string {
  return s.normalize('NFC');
}

/** `~`-relative, truncated, control characters stripped: safe to show, still untrusted. */
export function displayLabel(path: string, home: string, max = 120): string {
  let s = path === home ? '~' : path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
  s = nfc(s).replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '?');
  if (s.length > max) s = s.slice(0, max - 21) + '…' + s.slice(-20);
  return s;
}

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return home + p.slice(1);
  return p;
}

export function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');
}
