/**
 * Builds a synthetic HOME for tests. Everything is fake and generic: the user
 * is "sample", projects are "demo-*". No real names, paths or documents.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExecResult } from '../src/platform/types.js';
import { FakePlatform, type FakeOptions } from '../src/platform/fake.js';
import { runsDirFor } from '../src/scan.js';
import type { ProtectionContext } from '../src/safety/protected.js';
import { RunStore } from '../src/runs.js';

export interface Fixture {
  home: string;
  p: FakePlatform;
  store: RunStore;
  protection: ProtectionContext;
  file(rel: string, bytes?: number, content?: string): string;
  dir(rel: string): string;
  cleanup(): void;
}

export function writeBytes(path: string, bytes: number, fill = 'x'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, fill.repeat(bytes));
}

export interface FixtureOptions extends Partial<FakeOptions> {
  tools?: Record<string, (args: string[]) => ExecResult | undefined>;
  backup?: boolean;
}

export function makeFixture(opts: FixtureOptions = {}): Fixture {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mca-home-')));
  const tools: Record<string, (args: string[]) => ExecResult | undefined> = {
    '/usr/bin/sw_vers': () => ({ code: 0, stdout: '15.0\n', stderr: '' }),
    '/usr/bin/tmutil': (args) =>
      args[0] === 'destinationinfo'
        ? opts.backup
          ? { code: 0, stdout: 'Name : Backup Disk\nKind : Local\n', stderr: '' }
          : { code: 0, stdout: 'No destinations configured.\n', stderr: '' }
        : { code: 0, stdout: '/Volumes/Backup/2026-01-01-000000\n', stderr: '' },
    '/usr/bin/defaults': () => ({ code: 0, stdout: '0\n', stderr: '' }),
    '/usr/bin/pgrep': () => ({ code: 1, stdout: '', stderr: '' }),
    '/usr/bin/xcrun': () => ({ code: 1, stdout: '', stderr: 'no xcrun in tests' }),
    '/bin/cat': (args) => {
      try {
        return { code: 0, stdout: execFileSync('/bin/cat', args, { encoding: 'utf8' }), stderr: '' };
      } catch {
        return { code: 1, stdout: '', stderr: '' };
      }
    },
    // Real git, but only ever inside the temporary HOME.
    git: (args) => {
      try {
        return { code: 0, stdout: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
      }
    },
    ...opts.tools,
  };
  const p = new FakePlatform({
    home,
    capacityBytes: opts.capacityBytes ?? 10_000_000_000,
    denied: opts.denied,
    mdls: opts.mdls,
    now: opts.now,
    env: opts.env,
    uid: opts.uid ?? process.getuid?.() ?? 501,
    exec: (cmd, args) => tools[cmd]?.(args),
  });
  mkdirSync(join(home, '.Trash'), { recursive: true });
  const protection: ProtectionContext = {
    home,
    trashRoot: p.trashRoot,
    runsDir: runsDirFor(home),
    userProtect: [],
    unlocked: new Set(),
  };
  return {
    home,
    p,
    store: new RunStore(runsDirFor(home)),
    protection,
    file(rel, bytes = 2_000_000, content) {
      const path = join(home, rel);
      if (content !== undefined) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      } else writeBytes(path, bytes);
      return path;
    },
    dir(rel) {
      const path = join(home, rel);
      mkdirSync(path, { recursive: true });
      return path;
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** A clean, pushed git repo with a gitignored node_modules (bare remote inside HOME). */
export function makeRepo(fx: Fixture, rel: string, opts: { dirty?: boolean; unpushed?: boolean } = {}): string {
  const repo = fx.dir(rel);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  const remote = fx.dir(`remotes/${rel.replace(/\//g, '_')}.git`);
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'sample@example.com');
  git('config', 'user.name', 'Sample');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'package.json'), '{"name":"demo"}\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\nplaywright-report/\n.next/\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');
  if (opts.unpushed) {
    writeFileSync(join(repo, 'more.txt'), 'x');
    git('add', '.');
    git('commit', '-q', '-m', 'more');
  }
  if (opts.dirty) writeFileSync(join(repo, 'dirty.txt'), 'x');
  return repo;
}
