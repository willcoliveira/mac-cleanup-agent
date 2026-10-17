/**
 * Developer-tool detectors. Each one asks the tool itself (docker, xcrun simctl)
 * when it can, because a folder size alone hides what is actually reclaimable:
 * Docker.raw is a sparse 460 GB file that may hold 25 GB, and simulator
 * runtimes are mounted disk images that `du` would count twice.
 */
import { basename, join } from 'node:path';
import { sha256 } from '../core/util.js';
import type { Platform } from '../platform/types.js';
import { identityOf, pathCandidate } from './search.js';
import type { Candidate, DetectorContext } from './types.js';

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

async function firstExisting(p: Platform, paths: string[]): Promise<string | null> {
  for (const path of paths) if (await p.lstat(path)) return path;
  return null;
}

export function virtualIdentity(fingerprint: string, size: number) {
  return { kind: 'virtual' as const, dev: 0, ino: 0, size, mtimeMs: 0, fingerprint: sha256(fingerprint).slice(0, 32) };
}

/** Docker uses decimal units with lowercase k: "1.2kB", "13.35GB", "0B". */
export function parseDockerSize(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*([kKMGT]?B)/);
  if (!m) return 0;
  const mult: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  return Math.round(Number(m[1]) * (mult[m[2] ?? 'B'] ?? 1));
}

export async function dockerBinary(p: Platform): Promise<string | null> {
  return firstExisting(p, ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker']);
}

export async function detectDocker(ctx: DetectorContext): Promise<Candidate[]> {
  const { p } = ctx;
  const docker = await dockerBinary(p);
  if (!docker) return [];
  const df = await p.exec(docker, ['system', 'df', '--format', '{{json .}}'], { timeoutMs: 30_000 });
  if (df.code !== 0) {
    const raw = join(p.home, 'Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw');
    const s = await p.lstat(raw);
    if (!s) return [];
    return [
      {
        path: '',
        bytes: s.allocated,
        identity: virtualIdentity('docker-raw-stopped', s.allocated),
        title: 'Docker disk image (Docker is not running)',
        label: 'Docker disk image',
        action: { type: 'report-only' },
        notes: ['Start Docker Desktop and scan again to see what is reclaimable. Never delete Docker.raw by hand.'],
      },
    ];
  }
  const rows = df.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as { Type: string; TotalCount: string; Size: string; Reclaimable: string };
      } catch {
        return null;
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const out: Candidate[] = [];
  const images = rows.find((r) => r.Type === 'Images');
  const cache = rows.find((r) => r.Type === 'Build Cache');
  const volumes = rows.find((r) => r.Type === 'Local Volumes');
  if (images && parseDockerSize(images.Reclaimable) > 0) {
    const bytes = parseDockerSize(images.Reclaimable);
    out.push({
      path: '',
      bytes,
      identity: virtualIdentity(`docker-images:${images.TotalCount}:${images.Size}`, bytes),
      title: `Docker images not used by any container (${images.TotalCount} images in total)`,
      label: 'Docker unused images',
      action: { type: 'tool', tool: 'docker-image-prune' },
    });
  }
  if (cache && parseDockerSize(cache.Reclaimable) > 0) {
    const bytes = parseDockerSize(cache.Reclaimable);
    out.push({
      path: '',
      bytes,
      identity: virtualIdentity(`docker-build-cache:${cache.TotalCount}:${cache.Size}`, bytes),
      title: 'Docker build cache',
      label: 'Docker build cache',
      action: { type: 'tool', tool: 'docker-builder-prune' },
    });
  }
  if (volumes && Number(volumes.TotalCount) > 0) {
    const bytes = parseDockerSize(volumes.Size);
    out.push({
      path: '',
      bytes,
      identity: virtualIdentity(`docker-volumes:${volumes.TotalCount}:${volumes.Size}`, bytes),
      title: `Docker volumes (${volumes.TotalCount}): may hold database data`,
      label: 'Docker volumes',
      action: { type: 'report-only' },
      risk: 'caution',
      notes: ['Volumes often hold databases. Remove them by name with `docker volume rm` only after checking each one.'],
    });
  }
  return out;
}

interface SimDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

export async function listSimDevices(p: Platform): Promise<Array<SimDevice & { runtime: string }>> {
  const r = await p.exec('/usr/bin/xcrun', ['simctl', 'list', 'devices', '--json'], { timeoutMs: 60_000 });
  if (r.code !== 0) return [];
  try {
    const data = JSON.parse(r.stdout) as { devices: Record<string, SimDevice[]> };
    return Object.entries(data.devices).flatMap(([runtime, list]) => list.map((d) => ({ ...d, runtime })));
  } catch {
    return [];
  }
}

function runtimeLabel(runtimeId: string): string {
  const m = runtimeId.match(/SimRuntime\.([a-zA-Z]+)-(\d+)-(\d+)/);
  return m ? `${m[1]} ${m[2]}.${m[3]}` : runtimeId;
}

export async function detectSimulators(ctx: DetectorContext): Promise<Candidate[]> {
  const { p } = ctx;
  const out: Candidate[] = [];
  for (const d of await listSimDevices(p)) {
    if (!UDID.test(d.udid)) continue;
    const dir = join(p.home, 'Library/Developer/CoreSimulator/Devices', d.udid);
    const s = await p.lstat(dir);
    if (!s || s.kind !== 'dir') continue;
    const bytes = (await p.usage(dir)).bytes;
    const apps = await p.readdir(join(dir, 'data/Containers/Bundle/Application'));
    const appCount = Array.isArray(apps) ? apps.filter((a) => a.kind === 'dir').length : 0;
    const notes: string[] = [];
    if (appCount > 0) notes.push(`${appCount} installed app(s): check for test accounts or data you still need before deleting.`);
    if (!d.isAvailable) notes.push('Unavailable: its runtime is no longer installed.');
    if (d.state === 'Booted') notes.push('Currently booted: shut it down first.');
    out.push({
      path: dir,
      bytes,
      identity: { ...identityOf(s, bytes), kind: 'dir' },
      title: `${d.name} (${runtimeLabel(d.runtime)})`,
      label: `Simulator: ${d.name} (${runtimeLabel(d.runtime)})`,
      action: { type: 'tool', tool: 'simctl-delete-device', arg: d.udid },
      notes,
      risk: appCount > 0 ? 'caution' : undefined,
    });
  }
  return out;
}

interface SimRuntime {
  identifier: string;
  version: string;
  sizeBytes: number;
  state: string;
  deletable?: boolean;
  runtimeIdentifier?: string;
}

export async function detectRuntimes(ctx: DetectorContext): Promise<Candidate[]> {
  const { p } = ctx;
  const r = await p.exec('/usr/bin/xcrun', ['simctl', 'runtime', 'list', '-j'], { timeoutMs: 60_000 });
  if (r.code !== 0) return [];
  let runtimes: SimRuntime[];
  try {
    runtimes = Object.values(JSON.parse(r.stdout) as Record<string, SimRuntime>);
  } catch {
    return [];
  }
  const devices = await listSimDevices(p);
  const versions = runtimes.map((x) => x.version).sort((a, b) => compareVersions(b, a));
  const newest = versions[0];
  return runtimes
    .filter((x) => UDID.test(x.identifier) && x.deletable !== false)
    .map((x) => {
      const using = devices.filter((d) => d.runtime === x.runtimeIdentifier).length;
      const notes = [`${using} simulator device(s) use this runtime; they become unavailable after it is deleted.`];
      if (x.version === newest) notes.push('This is your newest runtime; keep it if you still run simulators.');
      return {
        path: '',
        bytes: x.sizeBytes,
        identity: virtualIdentity(`runtime:${x.identifier}:${x.version}`, x.sizeBytes),
        title: `iOS runtime ${x.version}`,
        label: `Simulator runtime ${x.version}`,
        action: { type: 'tool' as const, tool: 'simctl-runtime-delete' as const, arg: x.identifier },
        notes,
      };
    });
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function detectAvds(ctx: DetectorContext): Promise<Candidate[]> {
  const { p } = ctx;
  const dir = join(p.home, '.android/avd');
  const entries = await p.readdir(dir);
  if (!Array.isArray(entries)) return [];
  const out: Candidate[] = [];
  for (const e of entries) {
    if (e.kind !== 'dir' || !e.name.endsWith('.avd')) continue;
    const name = e.name.slice(0, -4);
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) continue;
    const c = await pathCandidate(p, join(dir, e.name));
    if (!c) continue;
    const snaps = await p.lstat(join(dir, e.name, 'snapshots'));
    out.push({
      ...c,
      title: `Android emulator ${name}`,
      label: `Android emulator: ${name}`,
      action: { type: 'tool', tool: 'avd-delete', arg: name },
      notes: snaps ? ['Has Quick Boot snapshots. Turn snapshots off on a fresh AVD to keep it small.'] : [],
    });
  }
  return out;
}

/** All but the highest-versioned child folder of `dir`. */
async function olderVersions(p: Platform, dir: string, filter: (name: string) => boolean = () => true): Promise<Candidate[]> {
  const entries = await p.readdir(dir);
  if (!Array.isArray(entries)) return [];
  const versions = entries.filter((e) => e.kind === 'dir' && filter(e.name)).map((e) => e.name).sort(compareVersions);
  const out: Candidate[] = [];
  for (const v of versions.slice(0, -1)) {
    const c = await pathCandidate(p, join(dir, v));
    if (c) out.push(c);
  }
  return out;
}

export async function detectNdkOld(ctx: DetectorContext): Promise<Candidate[]> {
  const sdk = ctx.p.env.ANDROID_HOME ?? join(ctx.p.home, 'Library/Android/sdk');
  const out = await olderVersions(ctx.p, join(sdk, 'ndk'), (n) => /^\d+\.\d+\.\d+$/.test(n));
  return out.map((c) => ({ ...c, title: `Android NDK ${basename(c.path)}` }));
}

export async function detectPlaywrightOld(ctx: DetectorContext): Promise<Candidate[]> {
  const { p } = ctx;
  const dir = join(p.home, 'Library/Caches/ms-playwright');
  const entries = await p.readdir(dir);
  if (!Array.isArray(entries)) return [];
  const groups = new Map<string, Array<{ name: string; rev: number }>>();
  for (const e of entries) {
    const m = e.kind === 'dir' ? e.name.match(/^(.+)-(\d+)$/) : null;
    if (!m) continue;
    const list = groups.get(m[1] ?? '') ?? [];
    list.push({ name: e.name, rev: Number(m[2]) });
    groups.set(m[1] ?? '', list);
  }
  const out: Candidate[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.rev - b.rev);
    for (const old of list.slice(0, -1)) {
      const c = await pathCandidate(p, join(dir, old.name));
      if (c) out.push({ ...c, title: `Playwright ${old.name}` });
    }
  }
  return out;
}

export async function detectNodeOld(ctx: DetectorContext): Promise<Candidate[]> {
  const { p } = ctx;
  const dir = join(p.home, '.nvm/versions/node');
  const entries = await p.readdir(dir);
  if (!Array.isArray(entries)) return [];
  let defaultAlias = '';
  const alias = await p.exec('/bin/cat', [join(p.home, '.nvm/alias/default')]);
  if (alias.code === 0) defaultAlias = alias.stdout.trim().replace(/^v/, '');
  const byMajor = new Map<string, string[]>();
  for (const e of entries) {
    const m = e.kind === 'dir' ? e.name.match(/^v(\d+)\.\d+\.\d+$/) : null;
    if (!m) continue;
    const list = byMajor.get(m[1] ?? '') ?? [];
    list.push(e.name);
    byMajor.set(m[1] ?? '', list);
  }
  const out: Candidate[] = [];
  for (const list of byMajor.values()) {
    list.sort(compareVersions);
    for (const v of list.slice(0, -1)) {
      if (defaultAlias && v.replace(/^v/, '') === defaultAlias) continue;
      if (process.execPath.includes(`/${v}/`)) continue;
      const c = await pathCandidate(p, join(dir, v));
      if (c) out.push({ ...c, title: `Node.js ${v}` });
    }
  }
  return out;
}

export async function detectHomebrew(ctx: DetectorContext): Promise<Candidate[]> {
  const { p } = ctx;
  const brew = await firstExisting(p, ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']);
  if (!brew) return [];
  const r = await p.exec(brew, ['cleanup', '-n'], { timeoutMs: 120_000 });
  const m = (r.stdout + r.stderr).match(/free approximately ([\d.]+)\s*([KMGT]?B)/i);
  if (!m) return [];
  const mult: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  const bytes = Math.round(Number(m[1]) * (mult[(m[2] ?? 'B').toUpperCase()] ?? 1));
  return [{ path: '', bytes, identity: virtualIdentity(`brew-cleanup:${bytes}`, bytes), title: 'Homebrew old versions and downloads', label: 'Homebrew cleanup' }];
}
