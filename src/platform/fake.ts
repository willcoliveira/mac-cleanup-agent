/**
 * A test platform over a real temporary directory that plays the role of HOME.
 * It simulates the parts of macOS the tests must control: privacy-protected
 * (TCC) folders, the Trash and its collision renaming, external tools
 * (docker, xcrun, tmutil, ...), Spotlight metadata and the disk's capacity.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { DirEntry, ExecResult, FileStat, Platform, TrashResult, Usage } from './types.js';

export type ExecHandler = (cmd: string, args: string[]) => ExecResult | undefined;

export interface FakeOptions {
  home: string;
  uid?: number;
  env?: Record<string, string | undefined>;
  /** Total capacity of the simulated disk; available = capacity - bytes under HOME. */
  capacityBytes?: number;
  /** Absolute paths whose readdir is denied (simulates missing Full Disk Access). */
  denied?: string[];
  exec?: ExecHandler;
  mdls?: Record<string, Record<string, string>>;
  now?: () => Date;
}

function kindOf(s: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): FileStat['kind'] {
  if (s.isSymbolicLink()) return 'symlink';
  if (s.isDirectory()) return 'dir';
  if (s.isFile()) return 'file';
  return 'other';
}

export class FakePlatform implements Platform {
  readonly home: string;
  readonly uid: number;
  readonly env: Record<string, string | undefined>;
  readonly trashRoot: string;
  denied: Set<string>;
  execLog: Array<{ cmd: string; args: string[] }> = [];
  private readonly capacity: number;
  private readonly execHandler: ExecHandler;
  private readonly mdlsData: Record<string, Record<string, string>>;
  private readonly clock: () => Date;
  private collisionCounter = 0;

  constructor(opts: FakeOptions) {
    this.home = opts.home;
    this.uid = opts.uid ?? 501;
    this.env = { HOME: opts.home, ...(opts.env ?? {}) };
    this.trashRoot = join(opts.home, '.Trash');
    this.capacity = opts.capacityBytes ?? 500 * 1024 ** 3;
    this.denied = new Set(opts.denied ?? []);
    this.execHandler = opts.exec ?? (() => undefined);
    this.mdlsData = opts.mdls ?? {};
    this.clock = opts.now ?? (() => new Date());
  }

  now(): Date {
    return this.clock();
  }

  setMdls(path: string, data: Record<string, string>): void {
    this.mdlsData[path] = data;
  }

  async lstat(path: string): Promise<FileStat | null> {
    try {
      const s = await lstat(path);
      return {
        kind: kindOf(s),
        dev: s.dev,
        ino: s.ino,
        size: s.size,
        allocated: s.blocks * 512,
        mtimeMs: s.mtimeMs,
        mode: s.mode & 0o7777,
        uid: s.uid,
      };
    } catch {
      return null;
    }
  }

  async readdir(path: string): Promise<DirEntry[] | 'denied' | null> {
    if (this.denied.has(path)) return 'denied';
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, kind: kindOf(e) }));
    } catch {
      return null;
    }
  }

  async realpath(path: string): Promise<string | null> {
    try {
      return await realpath(path);
    } catch {
      return null;
    }
  }

  async usage(path: string): Promise<Usage> {
    let bytes = 0;
    let partial = false;
    const walk = async (p: string): Promise<void> => {
      if (this.denied.has(p)) {
        partial = true;
        return;
      }
      let s;
      try {
        s = await lstat(p);
      } catch {
        return;
      }
      bytes += s.blocks * 512;
      if (s.isDirectory()) {
        for (const name of await readdir(p)) await walk(join(p, name));
      }
    };
    await walk(path);
    return { bytes, partial };
  }

  async statfs(): Promise<{ available: number; total: number }> {
    const used = (await this.usage(this.home)).bytes;
    return { available: Math.max(0, this.capacity - used), total: this.capacity };
  }

  async exec(cmd: string, args: string[]): Promise<ExecResult> {
    this.execLog.push({ cmd, args });
    return this.execHandler(cmd, args) ?? { code: 127, stdout: '', stderr: `${cmd}: not available in fake` };
  }

  async trash(paths: string[]): Promise<TrashResult[]> {
    await mkdir(this.trashRoot, { recursive: true });
    const out: TrashResult[] = [];
    for (const p of paths) {
      const s = await this.lstat(p);
      if (!s) {
        out.push({ path: p, ok: false, error: `The file “${basename(p)}” doesn’t exist.` });
        continue;
      }
      let target = join(this.trashRoot, basename(p));
      if (await this.lstat(target)) {
        // Same shape as Finder: "<name> HH-MM-SS-mmm<ext>".
        this.collisionCounter += 1;
        const ext = s.kind === 'dir' ? '' : extname(p);
        const stem = ext ? basename(p).slice(0, -ext.length) : basename(p);
        target = join(this.trashRoot, `${stem}${ext} 12-00-00-${String(this.collisionCounter).padStart(3, '0')}${ext}`);
      }
      await rename(p, target);
      out.push({ path: p, ok: true, resulting: target });
    }
    return out;
  }

  async removeTree(path: string): Promise<void> {
    await rm(path, { recursive: true, force: false });
  }

  async chmod(path: string, mode: number): Promise<void> {
    await chmod(path, mode);
  }

  async sha256File(path: string): Promise<string> {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  async mdls(path: string, keys: string[]): Promise<Record<string, string | null>> {
    const data = this.mdlsData[path] ?? {};
    return Object.fromEntries(keys.map((k) => [k, data[k] ?? null]));
  }
}
