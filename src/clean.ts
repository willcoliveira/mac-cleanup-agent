/**
 * clean: moves approved items to the Trash (or runs their tool-native cleaner),
 * one verified item at a time.
 *
 * Per path item:  lstat → same dev/ino/kind → realpath unchanged (no symlink
 * component) → still not protected → trash via NSFileManager → lstat the
 * resulting URL → same dev/ino. Any mismatch is skipped and reported.
 */
import { dirname, join } from 'node:path';
import type { Approvals, Item, ManifestEntry, Results, Scan, ToolId } from './core/schemas.js';
import { CONTRACT_VERSION } from './core/schemas.js';
import { dockerBinary, parseDockerSize } from './detectors/dev.js';
import type { Platform } from './platform/types.js';
import type { RunStore } from './runs.js';
import { runningApps } from './safety/environment.js';
import { checkProtected, type ProtectionContext } from './safety/protected.js';

export const DEFAULT_MAX_AGE_HOURS = 24;

/** Destructive tools run in this order; simulator runtimes always go last. */
const TOOL_ORDER: ToolId[] = [
  'npm-cache-clean',
  'uv-cache-clean',
  'brew-cleanup',
  'docker-builder-prune',
  'docker-image-prune',
  'avd-delete',
  'simctl-delete-device',
  'simctl-delete-unavailable',
  'simctl-runtime-delete',
];

export function isApproved(item: Item, a: Approvals): boolean {
  if (item.action.type === 'report-only') return false;
  const explicit = a.items[item.id];
  if (explicit !== undefined) return explicit;
  // Items proposed by an AI sub-agent never ride on an area-level approval.
  if (item.aiClassified) return false;
  return a.areas[item.area] ?? false;
}

export interface CleanPlan {
  scan: Scan;
  selected: Item[];
  blocked: Array<{ item: Item; reason: string }>;
}

export function verifyApprovals(scan: Scan, sha: string, approvals: Approvals, now: Date, maxAgeHours = DEFAULT_MAX_AGE_HOURS): void {
  if (approvals.scan_id !== scan.scan_id) throw new Error('approvals belong to a different scan');
  if (approvals.scan_sha256 !== sha) throw new Error('scan.json changed after the approvals were made (hash mismatch). Scan again.');
  const age = (now.getTime() - Date.parse(scan.created_at)) / 3_600_000;
  if (age > maxAgeHours) throw new Error(`scan is ${age.toFixed(1)} h old (limit ${maxAgeHours} h). Scan again so the inventory is current.`);
  if (age < -0.1) throw new Error('scan timestamp is in the future');
}

export async function planClean(p: Platform, scan: Scan, approvals: Approvals): Promise<CleanPlan> {
  const running = new Set(await runningApps(p));
  const selected: Item[] = [];
  const blocked: CleanPlan['blocked'] = [];
  for (const item of scan.items.filter((i) => isApproved(i, approvals))) {
    const open = item.requiresQuit.filter((a) => running.has(a));
    if (open.length) blocked.push({ item, reason: `quit ${open.join(', ')} first` });
    else selected.push(item);
  }
  const order = (i: Item) => (i.action.type === 'tool' ? 1 + TOOL_ORDER.indexOf(i.action.tool) : 0);
  selected.sort((a, b) => order(a) - order(b));
  return { scan, selected, blocked };
}

/** Re-checks a path item right before it is moved. Returns a skip reason or null. */
export async function verifyIdentity(p: Platform, item: Item, protection: ProtectionContext): Promise<string | null> {
  const s = await p.lstat(item.path);
  if (!s) return 'no longer exists';
  if (s.kind === 'symlink') return 'is now a symlink';
  if (s.dev !== item.identity.dev || s.ino !== item.identity.ino) return 'was replaced since the scan (different inode)';
  const kind = s.kind === 'dir' ? 'dir' : 'file';
  if (kind !== item.identity.kind) return 'changed type since the scan';
  if (kind === 'file' && s.allocated !== item.identity.size) return 'changed size since the scan';
  // The scan stored the realpath; any difference now means a symlink was swapped into the path.
  if ((await p.realpath(item.path)) !== item.path) return 'its path now goes through a symlink';
  if (checkProtected(item.path, protection, { insideUserFolders: true }).protected) return 'is protected';
  return null;
}

async function runTool(p: Platform, item: Item): Promise<{ ok: boolean; reason?: string; trashed?: Array<{ original: string; resulting: string; dev: number; ino: number; bytes: number }> }> {
  if (item.action.type !== 'tool') return { ok: false, reason: 'not a tool item' };
  const arg = item.action.arg ?? '';
  const exec = async (cmd: string, args: string[], timeoutMs = 600_000) => {
    const r = await p.exec(cmd, args, { timeoutMs });
    return r.code === 0 ? { ok: true } : { ok: false, reason: (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}` };
  };
  switch (item.action.tool) {
    case 'npm-cache-clean':
      return exec('npm', ['cache', 'clean', '--force']);
    case 'uv-cache-clean':
      return exec('uv', ['cache', 'clean']);
    case 'brew-cleanup': {
      const brew = (await p.lstat('/opt/homebrew/bin/brew')) ? '/opt/homebrew/bin/brew' : '/usr/local/bin/brew';
      return exec(brew, ['cleanup']);
    }
    case 'docker-image-prune':
    case 'docker-builder-prune': {
      const docker = await dockerBinary(p);
      if (!docker) return { ok: false, reason: 'docker CLI not found' };
      const df = await p.exec(docker, ['system', 'df', '--format', '{{json .}}'], { timeoutMs: 30_000 });
      if (df.code !== 0) return { ok: false, reason: 'Docker is not running' };
      const type = item.action.tool === 'docker-image-prune' ? 'Images' : 'Build Cache';
      const row = df.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { Type: string; Reclaimable: string }).find((r) => r.Type === type);
      if (!row || parseDockerSize(row.Reclaimable) === 0) return { ok: false, reason: 'nothing reclaimable any more' };
      // Never `system prune --volumes`: volumes hold databases and are only removed by name, by the user.
      return item.action.tool === 'docker-image-prune' ? exec(docker, ['image', 'prune', '-a', '-f']) : exec(docker, ['builder', 'prune', '-a', '-f']);
    }
    case 'simctl-delete-device': {
      if (!/^[0-9A-F-]{36}$/i.test(arg)) return { ok: false, reason: 'invalid device id' };
      const s = await p.lstat(item.path);
      if (!s || s.ino !== item.identity.ino) return { ok: false, reason: 'device folder changed since the scan' };
      return exec('/usr/bin/xcrun', ['simctl', 'delete', arg]);
    }
    case 'simctl-delete-unavailable':
      return exec('/usr/bin/xcrun', ['simctl', 'delete', 'unavailable']);
    case 'simctl-runtime-delete':
      if (!/^[0-9A-F-]{36}$/i.test(arg)) return { ok: false, reason: 'invalid runtime id' };
      return exec('/usr/bin/xcrun', ['simctl', 'runtime', 'delete', arg]);
    case 'avd-delete': {
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(arg)) return { ok: false, reason: 'invalid emulator name' };
      const s = await p.lstat(item.path);
      if (!s || s.ino !== item.identity.ino) return { ok: false, reason: 'emulator folder changed since the scan' };
      const ini = join(dirname(item.path), `${arg}.ini`);
      const targets = [item.path, ...((await p.lstat(ini)) ? [ini] : [])];
      const moved = await p.trash(targets);
      const trashed = [];
      for (const m of moved) {
        if (!m.ok || !m.resulting) return { ok: false, reason: m.error ?? 'could not move to Trash', trashed };
        const st = await p.lstat(m.resulting);
        if (st) trashed.push({ original: m.path, resulting: m.resulting, dev: st.dev, ino: st.ino, bytes: m.path === item.path ? item.bytes : st.allocated });
      }
      return { ok: true, trashed };
    }
  }
}

export interface CleanEvents {
  onItem?: (item: Item, entry: ManifestEntry) => void;
}

export async function executeClean(p: Platform, store: RunStore, plan: CleanPlan, protection: ProtectionContext, events: CleanEvents = {}): Promise<Results> {
  const scanId = plan.scan.scan_id;
  const release = store.acquireLock();
  const at = () => p.now().toISOString();
  const record = (item: Item, entry: Omit<ManifestEntry, 'id' | 'area' | 'at'>) => {
    const full: ManifestEntry = { id: item.id, area: item.area, at: at(), ...entry };
    store.appendManifest(scanId, full);
    events.onItem?.(item, full);
  };
  try {
    for (const { item, reason } of plan.blocked) record(item, { op: 'skip', status: 'skipped', reason, bytes: 0 });

    const pathItems = plan.selected.filter((i) => i.action.type === 'trash');
    const verified: Item[] = [];
    for (const item of pathItems) {
      const why = await verifyIdentity(p, item, protection);
      if (why) record(item, { op: 'skip', status: 'skipped', reason: `${why}; scan again to include it`, original: item.path, bytes: 0 });
      else verified.push(item);
    }
    const moved = await p.trash(verified.map((i) => i.path));
    for (const [idx, item] of verified.entries()) {
      const m = moved[idx];
      if (!m || !m.ok || !m.resulting) {
        record(item, { op: 'trash', status: 'failed', reason: m?.error ?? 'trash failed', original: item.path, bytes: 0 });
        continue;
      }
      const st = await p.lstat(m.resulting);
      if (!st || st.dev !== item.identity.dev || st.ino !== item.identity.ino) {
        // Moved, but we can't prove the Trash entry is ours: empty will leave it alone.
        record(item, { op: 'trash', status: 'failed', reason: 'moved, but the Trash entry does not match; empty will skip it', original: item.path, resulting: m.resulting, bytes: item.bytes });
        continue;
      }
      record(item, { op: 'trash', status: 'ok', original: item.path, resulting: m.resulting, dev: st.dev, ino: st.ino, bytes: item.bytes });
    }

    for (const item of plan.selected.filter((i) => i.action.type === 'tool')) {
      const r = await runTool(p, item);
      if (r.trashed?.length) {
        for (const t of r.trashed) record(item, { op: 'trash', status: 'ok', original: t.original, resulting: t.resulting, dev: t.dev, ino: t.ino, bytes: t.bytes });
      } else {
        record(item, { op: 'tool', status: r.ok ? 'ok' : 'failed', reason: r.reason, bytes: r.ok ? item.bytes : 0 });
      }
    }
  } finally {
    release();
  }
  return computeResults(p, store, plan.scan);
}

export async function computeResults(p: Platform, store: RunStore, scan: Scan): Promise<Results> {
  const entries = store.readManifest(scan.scan_id);
  const fs = await p.statfs(p.home);
  const now = p.now().toISOString();
  const results: Results = {
    contract_version: CONTRACT_VERSION,
    scan_id: scan.scan_id,
    before: scan.free,
    after: { availableBytes: fs.available, totalBytes: fs.total, metric: 'statfs.f_bavail', at: now },
    trashedBytes: entries.filter((e) => e.op === 'trash' && e.status === 'ok').reduce((s, e) => s + e.bytes, 0),
    trashedItems: entries.filter((e) => e.op === 'trash' && e.status === 'ok').length,
    emptiedBytes: entries.filter((e) => e.op === 'empty' && e.status === 'ok').reduce((s, e) => s + e.bytes, 0),
    skipped: entries.filter((e) => e.status === 'skipped').length,
    failed: entries.filter((e) => e.status === 'failed').length,
  };
  store.saveResults(results);
  return results;
}
