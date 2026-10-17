/**
 * The real macOS platform. Every external program runs through execFile with
 * an argument array — never a shell — so filenames with spaces, apostrophes,
 * trailing spaces or leading dashes are passed through untouched.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, readdir, realpath, rm, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DirEntry, ExecResult, FileStat, Platform, TrashResult, Usage } from './types.js';

/**
 * NSFileManager trashItemAtURL:resultingItemURL:error: through JXA. `/usr/bin/trash`
 * exists only on macOS 15+, rejects `--`, and does not print where a colliding
 * name was renamed to; the resulting URL is what `empty` later verifies.
 * Out-parameters must be `$()` boxes — `Ref()` crashes osascript (exit 139).
 */
const TRASH_JXA = `
ObjC.import('Foundation');
function run(argv) {
  const fm = $.NSFileManager.defaultManager;
  const out = [];
  for (const p of argv) {
    const res = $(); const err = $();
    const ok = fm.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(p), res, err);
    if (ok) out.push({ path: p, ok: true, resulting: ObjC.unwrap(res.path) });
    else out.push({ path: p, ok: false, error: ObjC.unwrap(err.localizedDescription) });
  }
  return JSON.stringify(out);
}`;

const TRASH_BATCH = 40;

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException).code === 'number' ? Number((error as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? (error ? String(error.message) : '') });
    });
  });
}

function kindOf(s: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): FileStat['kind'] {
  if (s.isSymbolicLink()) return 'symlink';
  if (s.isDirectory()) return 'dir';
  if (s.isFile()) return 'file';
  return 'other';
}

export class RealPlatform implements Platform {
  readonly home = homedir();
  readonly uid = process.getuid?.() ?? -1;
  readonly env = process.env;
  readonly trashRoot = join(homedir(), '.Trash');

  now(): Date {
    return new Date();
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
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, kind: kindOf(e) }));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') return 'denied';
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
    // du -s -k -x: allocated KiB, one filesystem. It exits non-zero when part of the
    // tree is unreadable but still prints the total of what it could read.
    const r = await run('/usr/bin/du', ['-skx', '--', path], 600_000);
    const kib = Number.parseInt(r.stdout.trim().split(/\s+/)[0] ?? '', 10);
    return { bytes: Number.isFinite(kib) ? kib * 1024 : 0, partial: r.code !== 0 };
  }

  async statfs(path: string): Promise<{ available: number; total: number }> {
    const s = await statfs(path);
    return { available: s.bavail * s.bsize, total: s.blocks * s.bsize };
  }

  exec(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return run(cmd, args, opts?.timeoutMs);
  }

  async trash(paths: string[]): Promise<TrashResult[]> {
    const results: TrashResult[] = [];
    for (let i = 0; i < paths.length; i += TRASH_BATCH) {
      const batch = paths.slice(i, i + TRASH_BATCH);
      const r = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', TRASH_JXA, ...batch], 600_000);
      let parsed: TrashResult[] | null = null;
      try {
        parsed = JSON.parse(r.stdout.trim()) as TrashResult[];
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.length !== batch.length) {
        // A crash mid-batch leaves some items possibly trashed; report all as failed so
        // nothing is assumed moved. `clean` re-checks every original path afterwards.
        for (const p of batch) results.push({ path: p, ok: false, error: `trash helper failed (exit ${r.code})` });
      } else {
        results.push(...parsed);
      }
    }
    return results;
  }

  async removeTree(path: string): Promise<void> {
    await rm(path, { recursive: true, force: false });
  }

  async chmod(path: string, mode: number): Promise<void> {
    await chmod(path, mode);
  }

  sha256File(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(path)
        .on('data', (d) => h.update(d))
        .on('error', reject)
        .on('end', () => resolve(h.digest('hex')));
    });
  }

  async mdls(path: string, keys: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const key of keys) {
      const r = await run('/usr/bin/mdls', ['-raw', '-name', key, '--', path], 10_000);
      const v = r.stdout.trim();
      out[key] = r.code !== 0 || v === '' || v === '(null)' ? null : v;
    }
    return out;
  }
}
