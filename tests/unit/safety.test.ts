import { chmodSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayLabel, formatBytes, isInside, nfc } from '../../src/core/util.js';
import { checkProtected, validateUnlock } from '../../src/safety/protected.js';
import { hasFullDiskAccess, refuseRoot } from '../../src/safety/environment.js';
import { applyChmodFix, isSensitiveName } from '../../src/security.js';
import { effectiveRules, loadBuiltinRules } from '../../src/rules/loader.js';
import { Rule, UserConfig } from '../../src/rules/schema.js';
import { makeFixture } from '../helpers.js';

const ctx = (home = '/Users/sample') => ({
  home,
  trashRoot: `${home}/.Trash`,
  runsDir: `${home}/Library/Application Support/mac-cleanup-agent/runs`,
  userProtect: [`${home}/Projects/keep`],
  unlocked: new Set<string>(),
});

describe('protected paths', () => {
  const c = ctx();
  it('hard-protects keychains, ssh, the Trash and the runs dir, including their parents', () => {
    for (const p of ['/Users/sample/Library/Keychains/login.keychain-db', '/Users/sample/.ssh/id_rsa', '/Users/sample/.Trash/x', '/Users/sample/Library']) {
      expect(checkProtected(p, c).protected).toBe(true);
    }
    expect(checkProtected('/Users/sample/Library', c)).toMatchObject({ unlockable: false });
  });
  it('protects personal data roots', () => {
    expect(checkProtected('/Users/sample/Pictures/Photos Library.photoslibrary/originals/1.heic', c).protected).toBe(true);
    expect(checkProtected('/Users/sample/Library/Messages/chat.db', c).protected).toBe(true);
    expect(checkProtected('/Users/sample/Library/Application Support/Google/Chrome/Default', c).protected).toBe(true);
  });
  it('allows regenerable items inside Documents only for rules that opt in, never the folder itself', () => {
    const nm = '/Users/sample/Documents/app/node_modules';
    expect(checkProtected(nm, c).protected).toBe(true);
    expect(checkProtected(nm, c, { insideUserFolders: true }).protected).toBe(false);
    expect(checkProtected('/Users/sample/Documents', c, { insideUserFolders: true }).protected).toBe(true);
  });
  it('honours user protect entries and refuses home and system roots', () => {
    expect(checkProtected('/Users/sample/Projects/keep/node_modules', c).protected).toBe(true);
    expect(checkProtected('/Users/sample', c).protected).toBe(true);
    expect(checkProtected('/', c).protected).toBe(true);
    expect(checkProtected('/Users/sample/Library/Caches/pip', c).protected).toBe(false);
  });
  it('validates unlock requests strictly', () => {
    expect(validateUnlock('/Users/sample/Movies/*.mov', c)).toMatch(/globs/);
    expect(validateUnlock('/Users/sample/.ssh/id_rsa', c)).toMatch(/never/);
    expect(validateUnlock('/Users/sample/Library', c)).toMatch(/never|contains/);
    expect(validateUnlock('/Users/sample/Movies/old-render.mov', c)).toBeNull();
    const unlocked = { ...c, unlocked: new Set(['/Users/sample/Movies/old-render.mov']) };
    expect(checkProtected('/Users/sample/Movies/old-render.mov', unlocked).protected).toBe(false);
    expect(checkProtected('/Users/sample/.ssh/id_rsa', { ...c, unlocked: new Set(['/Users/sample/.ssh/id_rsa']) }).protected).toBe(true);
  });
});

describe('environment', () => {
  it('detects missing Full Disk Access through the Trash probe', async () => {
    const fx = makeFixture();
    expect(await hasFullDiskAccess(fx.p)).toBe(true);
    fx.p.denied.add(fx.p.trashRoot);
    expect(await hasFullDiskAccess(fx.p)).toBe(false);
    fx.cleanup();
  });
  it('refuses root and sudo', () => {
    const fx = makeFixture({ uid: 0 });
    expect(refuseRoot(fx.p)).toMatch(/never runs as root/);
    fx.cleanup();
    const fx2 = makeFixture({ env: { SUDO_USER: 'sample' } });
    expect(refuseRoot(fx2.p)).toMatch(/sudo/);
    fx2.cleanup();
  });
});

describe('rules', () => {
  it('ships a valid built-in catalog with unique ids', () => {
    const rules = loadBuiltinRules();
    expect(rules.length).toBeGreaterThan(30);
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
  });
  it('rejects regex-like patterns and parent traversal', () => {
    const base = { id: 'user.x', profile: 'developer', area: 'package-caches', title: 'Thing', risk: 'review', regenerate: 'it comes back' };
    expect(Rule.safeParse({ ...base, find: { search: { roots: ['~'], names: ['(a|b)'] } } }).success).toBe(false);
    expect(Rule.safeParse({ ...base, find: { paths: ['~/../etc'] } }).success).toBe(false);
    expect(Rule.safeParse({ ...base, action: { type: 'tool', tool: 'rm-rf' }, find: { paths: ['~/x'] } }).success).toBe(false);
  });
  it('lets users add and disable rules, but not weaken them', () => {
    const builtin = loadBuiltinRules();
    const user = UserConfig.parse({
      disable: ['dev.npm-cache'],
      rules: [{ id: 'user.renders', profile: 'creator', area: 'media-intermediates', title: 'My renders', risk: 'safe', find: { paths: ['~/Renders'] }, regenerate: 'Re-render' }],
    });
    const eff = effectiveRules(builtin, user);
    expect(eff.some((r) => r.id === 'dev.npm-cache')).toBe(false);
    expect(eff.find((r) => r.id === 'user.renders')?.risk).toBe('review');
    expect(() => effectiveRules(builtin, UserConfig.parse({ rules: [{ ...user.rules[0], id: 'dev.pip-cache' }] }))).toThrow(/reuses a built-in id/);
  });
});

describe('utilities', () => {
  it('formats decimal sizes and safe labels', () => {
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB');
    expect(formatBytes(267_000_000_000)).toBe('267 GB');
    expect(displayLabel('/Users/sample/Downloads/a‮b.txt', '/Users/sample')).toBe('~/Downloads/a?b.txt');
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(nfc('ç')).toBe('ç');
  });
});

describe('security fixes', () => {
  it('flags secret-looking names', () => {
    for (const n of ['github-recovery-codes.txt', 'client_secret_1.json', 'cert.p12', 'id_ed25519', '.env']) expect(isSensitiveName(`/x/${n}`)).toBe(true);
    expect(isSensitiveName('/x/holiday.jpg')).toBe(false);
  });
  it('only tightens permissions on regular files, never symlinks', async () => {
    const fx = makeFixture();
    const f = fx.file('.npmrc', 0, 'x');
    chmodSync(f, 0o644);
    const finding = { id: 's_000000000000', kind: 'loose-permissions' as const, label: '~/.npmrc', path: f, advice: '', fix: { type: 'chmod' as const, mode: '600' as const } };
    expect(await applyChmodFix(fx.p, finding)).toMatch(/644 → 600/);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const link = join(fx.home, 'link');
    symlinkSync(f, link);
    await expect(applyChmodFix(fx.p, { ...finding, path: link })).rejects.toThrow(/symlink/);
    chmodSync(f, 0o400);
    await expect(applyChmodFix(fx.p, finding)).rejects.toThrow(/loosen/);
    fx.cleanup();
  });
});
