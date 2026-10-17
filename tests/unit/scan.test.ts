import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scan } from '../../src/core/schemas.js';
import { effectiveRules, loadBuiltinRules } from '../../src/rules/loader.js';
import { UserConfig } from '../../src/rules/schema.js';
import { runScan } from '../../src/scan.js';
import { buildStandardHome, type StandardHome } from '../fixtures/standard-home.js';
import { type Fixture, makeFixture } from '../helpers.js';

const ALL = ['developer', 'qa', 'pm', 'creator'] as const;

describe('scan on a synthetic home', () => {
  let fx: Fixture;
  let home: StandardHome;
  let scan: Scan;

  beforeEach(async () => {
    fx = makeFixture();
    home = buildStandardHome(fx);
    const rules = effectiveRules(loadBuiltinRules(), UserConfig.parse({ minBytes: { 'creator.large-files': 20_000_000 } }));
    scan = await runScan(fx.p, { profiles: [...ALL], areas: [], rules, protection: fx.protection });
  });
  afterEach(() => fx.cleanup());

  const paths = () => scan.items.map((i) => i.path);
  const byRule = (id: string) => scan.items.filter((i) => i.ruleId === id);

  it('finds package caches and app caches', () => {
    expect(paths()).toContain(join(fx.home, 'Library/Caches/pip'));
    expect(paths()).toContain(join(fx.home, '.gradle/caches'));
    expect(paths()).toContain(join(fx.home, 'Library/Caches/Google/Chrome'));
  });

  it('keeps the newest Playwright build and the newest NDK', () => {
    expect(byRule('qa.playwright-old-builds').map((i) => i.path)).toEqual([join(fx.home, 'Library/Caches/ms-playwright/chromium-1100')]);
    expect(byRule('dev.android-ndk-old').map((i) => i.path)).toEqual([join(fx.home, 'Library/Android/sdk/ndk/26.1.10909125')]);
  });

  it('offers gitignored node_modules inside Documents, but never tracked ones', () => {
    const nm = byRule('dev.node-modules').map((i) => i.path);
    expect(nm).toContain(join(home.repo, 'node_modules'));
    expect(nm).not.toContain(join(home.trackedRepo, 'node_modules'));
  });

  it('skips build outputs in a repo with uncommitted changes (clean-pushed policy)', () => {
    expect(paths()).not.toContain(join(home.dirtyRepo, '.next'));
  });

  it('finds test reports', () => {
    expect(byRule('qa.test-reports').map((i) => i.path)).toContain(join(home.repo, 'playwright-report'));
  });

  it('classifies screenshots but never a camera photo', () => {
    const shots = byRule('qa.screenshots').map((i) => i.path);
    expect(shots).toContain(join(fx.home, 'Downloads/Screenshot 2026-01-01 at 10.00.00.png'));
    expect(shots).toContain(join(fx.home, 'Downloads/IMG_1001.PNG'));
    expect(shots).not.toContain(home.cameraPhoto);
  });

  it('finds installers, recordings and zips that were already extracted', () => {
    expect(byRule('pm.installers').map((i) => i.path)).toContain(join(fx.home, 'Downloads/Demo Installer.dmg'));
    expect(byRule('qa.screen-recordings')).toHaveLength(1);
    expect(byRule('pm.archives-extracted').map((i) => i.path)).toEqual([join(fx.home, 'Downloads/report-bundle.zip')]);
  });

  it('never offers protected data, and never follows symlinks into it', () => {
    for (const p of paths()) {
      expect(p.includes('Photos Library.photoslibrary')).toBe(false);
      expect(p.includes('/Library/Mail')).toBe(false);
      expect(p.includes('/.ssh')).toBe(false);
      expect(p.includes('mail-link')).toBe(false);
      expect(p).not.toBe(join(fx.home, 'Documents'));
    }
    expect(scan.protected.map((p) => p.label)).toEqual(expect.arrayContaining(['Photos library', 'Mail']));
  });

  it('reports large files and duplicates without offering them', () => {
    const large = byRule('creator.large-files');
    expect(large.map((i) => i.path)).toContain(join(fx.home, 'Movies/raw-footage.mov'));
    expect(large.every((i) => i.action.type === 'report-only')).toBe(true);
    expect(scan.areas.some((a) => a.area === 'large-files')).toBe(false);
    expect(scan.duplicates).toHaveLength(1);
    expect(scan.duplicates[0]?.labels.sort()).toEqual(['~/Desktop/movie-copy-b.mov', '~/Downloads/movie-copy-a.mov']);
  });

  it('reports security findings without reading contents', () => {
    const labels = scan.security.map((s) => s.label);
    expect(labels).toContain('~/Downloads/github-recovery-codes.txt');
    expect(labels).toContain('~/Downloads/client_secret_000.apps.example.json');
    const loose = scan.security.filter((s) => s.kind === 'loose-permissions').map((s) => s.label);
    expect(loose).toEqual(expect.arrayContaining(['~/.android/adbkey', '~/.ssh/id_ed25519']));
  });

  it('counts what the user already had in the Trash', () => {
    expect(scan.trash.foreignItems).toBe(1);
  });

  it('gives every item a unique id and never nests items', () => {
    const ids = scan.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    const ps = paths().filter(Boolean);
    for (const a of ps) for (const b of ps) if (a !== b) expect(a.startsWith(b + '/')).toBe(false);
  });

  it('warns that no backup is configured', () => {
    expect(scan.warnings.join(' ')).toMatch(/No Time Machine backup/);
  });
});

describe('scan filters', () => {
  it('limits the scan to the requested areas and profiles', async () => {
    const fx = makeFixture();
    buildStandardHome(fx);
    const scan = await runScan(fx.p, { profiles: ['developer'], areas: ['package-caches'], rules: loadBuiltinRules(), protection: fx.protection });
    expect(new Set(scan.items.map((i) => i.area))).toEqual(new Set(['package-caches']));
    fx.cleanup();
  });
});
