/**
 * Deep mode, read-only. `inspect` lists what is inside a folder the rules did
 * not cover: child names (truncated), sizes, dates and an extension histogram.
 * It never reads file contents. Its output is UNTRUSTED: names are attacker-
 * controllable text, so they are data for the analyst, never instructions.
 *
 * `propose` turns one inspected entry (by entry id, never by path) into an
 * inventory item marked aiClassified. Such items are at least `review` risk
 * and are never covered by an area-level approval: a human approves each one.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { type AreaId, type Item, Scan } from './core/schemas.js';
import { displayLabel, isInside, itemId, nfc } from './core/util.js';
import type { Platform } from './platform/types.js';
import type { RunStore } from './runs.js';
import { checkProtected, type ProtectionContext, USER_FOLDER_ROOTS } from './safety/protected.js';
import { isSensitiveName } from './security.js';

export interface InspectEntry {
  entry: string;
  name: string;
  kind: 'dir' | 'file';
  bytes: number;
  modified: string;
}

export interface InspectResult {
  untrusted: true;
  root: string;
  bytes: number;
  partial: boolean;
  entries: InspectEntry[];
  more: number;
  extensions: Array<{ ext: string; files: number; bytes: number }>;
}

function entryId(path: string, ino: number): string {
  return 'x_' + createHash('sha256').update(`${path}\0${ino}`).digest('hex').slice(0, 12);
}

function sanitize(name: string): string {
  const n = nfc(name).replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '?');
  return n.length > 60 ? n.slice(0, 40) + '…' + n.slice(-19) : n;
}

export function canInspect(path: string, home: string, protection: ProtectionContext): string | null {
  if (!path.startsWith('/')) return 'inspect needs an absolute path';
  if (!isInside(path, home) || path === home) return 'inspect works on folders inside your home folder';
  const rel = path.slice(home.length + 1);
  if (USER_FOLDER_ROOTS.has(rel)) return null;
  const v = checkProtected(path, protection, { insideUserFolders: true });
  return v.protected ? `refusing: ${v.reason}` : null;
}

export async function inspect(p: Platform, store: RunStore, scanId: string, path: string, protection: ProtectionContext, top = 20): Promise<InspectResult> {
  const why = canInspect(path, p.home, protection);
  if (why) throw new Error(why);
  const real = await p.realpath(path);
  if (real !== path) throw new Error('refusing: path goes through a symlink');
  const entries = await p.readdir(path);
  if (entries === 'denied') throw new Error('macOS denied access (Full Disk Access needed)');
  if (!entries) throw new Error('not a readable folder');
  const list: Array<InspectEntry & { path: string; ino: number; dev: number; mtimeMs: number }> = [];
  const exts = new Map<string, { files: number; bytes: number }>();
  for (const e of entries.slice(0, 500)) {
    if (e.kind !== 'dir' && e.kind !== 'file') continue;
    const full = join(path, e.name);
    const s = await p.lstat(full);
    if (!s || (s.kind !== 'dir' && s.kind !== 'file')) continue;
    const bytes = s.kind === 'dir' ? (await p.usage(full)).bytes : s.allocated;
    if (s.kind === 'file') {
      const ext = extname(e.name).toLowerCase() || '(none)';
      const x = exts.get(ext) ?? { files: 0, bytes: 0 };
      exts.set(ext, { files: x.files + 1, bytes: x.bytes + bytes });
    }
    list.push({ entry: entryId(full, s.ino), name: sanitize(e.name), kind: s.kind, bytes, modified: new Date(s.mtimeMs).toISOString().slice(0, 10), path: full, ino: s.ino, dev: s.dev, mtimeMs: s.mtimeMs });
  }
  list.sort((a, b) => b.bytes - a.bytes);
  const cache = join(store.dir(scanId), 'inspect.jsonl');
  for (const x of list.slice(0, top)) appendFileSync(cache, JSON.stringify({ entry: x.entry, path: x.path, dev: x.dev, ino: x.ino, bytes: x.bytes, kind: x.kind, mtimeMs: x.mtimeMs }) + '\n', { mode: 0o600 });
  return {
    untrusted: true,
    root: displayLabel(path, p.home),
    bytes: list.reduce((s, x) => s + x.bytes, 0),
    partial: entries.length > 500,
    entries: list.slice(0, top).map(({ entry, name, kind, bytes, modified }) => ({ entry, name, kind, bytes, modified })),
    more: Math.max(0, list.length - top),
    extensions: [...exts.entries()].map(([ext, v]) => ({ ext, ...v })).sort((a, b) => b.bytes - a.bytes).slice(0, 10),
  };
}

export async function propose(
  p: Platform,
  store: RunStore,
  scanId: string,
  entry: string,
  area: AreaId,
  reason: string,
  protection: ProtectionContext,
): Promise<Item> {
  const cache = join(store.dir(scanId), 'inspect.jsonl');
  if (!existsSync(cache)) throw new Error('nothing inspected in this run yet');
  const rec = readFileSync(cache, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { entry: string; path: string; dev: number; ino: number; bytes: number; kind: 'dir' | 'file'; mtimeMs: number })
    .reverse()
    .find((r) => r.entry === entry);
  if (!rec) throw new Error(`unknown entry ${entry}; inspect its folder first`);
  if (isSensitiveName(rec.path)) throw new Error('refusing: looks like a secret or key file');
  const v = checkProtected(rec.path, protection, { insideUserFolders: true });
  if (v.protected) throw new Error(`refusing: ${v.reason}`);
  const s = await p.lstat(rec.path);
  if (!s || s.ino !== rec.ino || s.dev !== rec.dev) throw new Error('the entry changed since it was inspected; inspect again');
  const { scan } = store.loadScan(scanId);
  if (scan.items.some((i) => i.path && (isInside(rec.path, i.path) || isInside(i.path, rec.path)))) throw new Error('already covered by an item in this scan');
  const item: Item = {
    id: itemId(rec.path, rec.dev, rec.ino, scanId),
    ruleId: 'ai.proposed',
    area,
    profile: 'common',
    risk: 'caution',
    title: 'Proposed by deep-mode analysis',
    path: rec.path,
    label: displayLabel(rec.path, p.home),
    bytes: rec.bytes,
    identity: { kind: rec.kind, dev: rec.dev, ino: rec.ino, size: rec.kind === 'file' ? s.allocated : rec.bytes, mtimeMs: Math.floor(rec.mtimeMs) },
    action: { type: 'trash' },
    regenerate: 'Unknown: this was classified by an AI sub-agent. Check it yourself before approving.',
    notes: [`AI reason (untrusted): ${reason.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200)}`],
    aiClassified: true,
    requiresQuit: [],
  };
  const next = Scan.parse({ ...scan, items: [...scan.items, item] });
  const summary = next.areas.find((a) => a.area === area);
  if (summary) {
    summary.bytes += item.bytes;
    summary.items += 1;
    summary.maxRisk = 'caution';
  } else next.areas.push({ area, bytes: item.bytes, items: 1, maxRisk: 'caution' });
  store.saveScan(next);
  // The CLI itself re-pins existing approvals to the new scan hash; a hand edit of scan.json still breaks the pin.
  try {
    const a = store.loadApprovals(scanId);
    store.saveApprovals({ ...a, scan_sha256: store.loadScan(scanId).sha });
  } catch {
    /* no approvals yet */
  }
  return item;
}
