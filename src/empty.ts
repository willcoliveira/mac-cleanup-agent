/**
 * empty: the only permanent delete in the tool. It deletes exactly the Trash
 * entries this run created — identified by the resulting URL NSFileManager
 * returned plus the recorded dev/ino — and nothing else in the Trash. Finder's
 * "Empty Trash" is never used, so items the user trashed themselves survive.
 */
import { join } from 'node:path';
import type { ManifestEntry, Results, Scan } from './core/schemas.js';
import { isInside } from './core/util.js';
import { computeResults } from './clean.js';
import type { Platform } from './platform/types.js';
import type { RunStore } from './runs.js';

export interface EmptyPlan {
  entries: ManifestEntry[];
  bytes: number;
}

/** Trash roots this tool may delete inside: the user's Trash and per-volume .Trashes/<uid>. */
export function allowedTrashRoots(p: Platform): string[] {
  return [p.trashRoot];
}

export function isInsideTrash(p: Platform, path: string): boolean {
  if (allowedTrashRoots(p).some((r) => isInside(path, r) && path !== r)) return true;
  // External volumes: /Volumes/<name>/.Trashes/<uid>/...
  const m = path.match(/^\/Volumes\/[^/]+\/\.Trashes\/(\d+)\/.+/);
  return Boolean(m && Number(m[1]) === p.uid);
}

export function planEmpty(store: RunStore, scanId: string): EmptyPlan {
  const manifest = store.readManifest(scanId);
  const emptied = new Set(manifest.filter((e) => e.op === 'empty' || e.op === 'empty-skip').map((e) => e.resulting));
  const entries = manifest.filter((e) => e.op === 'trash' && e.status === 'ok' && e.resulting && !emptied.has(e.resulting));
  return { entries, bytes: entries.reduce((s, e) => s + e.bytes, 0) };
}

export async function executeEmpty(p: Platform, store: RunStore, scan: Scan, plan: EmptyPlan): Promise<Results> {
  const release = store.acquireLock();
  try {
    for (const e of plan.entries) {
      const resulting = e.resulting as string;
      const base = { id: e.id, area: e.area, resulting, at: p.now().toISOString() };
      if (!isInsideTrash(p, resulting)) {
        store.appendManifest(scan.scan_id, { ...base, op: 'empty-skip', status: 'skipped', reason: 'not inside the Trash; refusing', bytes: 0 });
        continue;
      }
      const s = await p.lstat(resulting);
      if (!s) {
        store.appendManifest(scan.scan_id, { ...base, op: 'empty-skip', status: 'skipped', reason: 'already gone (restored or emptied elsewhere)', bytes: 0 });
        continue;
      }
      if (s.dev !== e.dev || s.ino !== e.ino) {
        store.appendManifest(scan.scan_id, { ...base, op: 'empty-skip', status: 'skipped', reason: 'Trash entry changed since it was moved; left in place', bytes: 0 });
        continue;
      }
      try {
        await p.removeTree(resulting);
        store.appendManifest(scan.scan_id, { ...base, op: 'empty', status: 'ok', bytes: e.bytes });
      } catch (err) {
        store.appendManifest(scan.scan_id, { ...base, op: 'empty', status: 'failed', reason: (err as Error).message.slice(0, 300), bytes: 0 });
      }
    }
  } finally {
    release();
  }
  return computeResults(p, store, scan);
}

export function emptyConfirmationPhrase(count: number): string {
  return `EMPTY ${count}`;
}

export const NO_BACKUP_PHRASE = 'I HAVE NO BACKUP';

export function trashPathFor(p: Platform, name: string): string {
  return join(p.trashRoot, name);
}
