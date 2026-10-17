/**
 * Detectors for loose files in Downloads and Desktop. They only look at names,
 * sizes and Spotlight metadata — never file contents — except the duplicate
 * finder, which hashes same-size files outside protected and sensitive paths.
 */
import { join } from 'node:path';
import { nfc } from '../core/util.js';
import type { Platform } from '../platform/types.js';
import { checkProtected } from '../safety/protected.js';
import { isSensitiveName } from '../security.js';
import { identityOf, stem, topFiles } from './search.js';
import type { Candidate, DetectorContext } from './types.js';

const LOOSE_DIRS = ['Downloads', 'Desktop'];

const SCREENSHOT_NAME = /^(screenshot|screen shot|captura de ecr[ãa]|captura de pantalla|bildschirmfoto|capture d.[ée]cran|schermafbeelding|istantanea|スクリーンショット)/i;
const RECORDING_NAME = /^(screen recording|screenrecording|grava[çc][ãa]o do ecr[ãa]|grabaci[óo]n de pantalla|bildschirmaufnahme|enregistrement de l.[ée]cran)/i;
const IMAGE_EXT = /\.(png|jpe?g|heic|tiff?|gif|webp)$/i;
const VIDEO_EXT = /\.(mov|mp4|m4v)$/i;

async function looseFiles(p: Platform, dirs = LOOSE_DIRS) {
  const out = [];
  for (const d of dirs) out.push(...(await topFiles(p, join(p.home, d))));
  return out;
}

/** A camera photo carries the capturing device model; screenshots don't. */
export async function isCameraPhoto(p: Platform, path: string): Promise<boolean> {
  const md = await p.mdls(path, ['kMDItemAcquisitionModel', 'kMDItemAcquisitionMake']);
  return Boolean(md.kMDItemAcquisitionModel || md.kMDItemAcquisitionMake);
}

export async function detectInstallers(ctx: DetectorContext): Promise<Candidate[]> {
  const { p } = ctx;
  const apps = await p.readdir('/Applications');
  const appNames = Array.isArray(apps) ? apps.filter((a) => a.name.endsWith('.app')).map((a) => a.name.slice(0, -4).toLowerCase()) : [];
  const out: Candidate[] = [];
  for (const f of await topFiles(p, join(p.home, 'Downloads'))) {
    if (!/\.(dmg|pkg)$/i.test(f.name)) continue;
    const base = nfc(f.name).toLowerCase().replace(/\.(dmg|pkg)$/, '').replace(/[-_ ](mac|macos|osx|darwin|arm64|x64|universal|aarch64|intel|setup|installer)\b.*$/, '').replace(/\s*\(\d+\)$/, '');
    const installed = appNames.find((a) => a.length >= 3 && (a.startsWith(base) || base.startsWith(a) || base.replace(/[^a-z]/g, '').startsWith(a.replace(/[^a-z]/g, ''))));
    out.push({
      path: f.path,
      bytes: f.stat.allocated,
      identity: identityOf(f.stat, f.stat.allocated),
      notes: installed ? [`Looks installed already: /Applications/${installed}.app`] : ['No matching app found in /Applications.'],
    });
  }
  return out;
}

export async function detectScreenshots(ctx: DetectorContext): Promise<Candidate[]> {
  const { p } = ctx;
  const out: Candidate[] = [];
  for (const f of await looseFiles(p)) {
    const name = nfc(f.name);
    if (!IMAGE_EXT.test(name)) continue;
    const named = SCREENSHOT_NAME.test(name);
    // Phone screenshots arrive as IMG_1234.PNG with no camera metadata.
    const phonePng = /^img_\d+.*\.png$/i.test(name);
    if (!named && !phonePng) continue;
    if (await isCameraPhoto(p, f.path)) continue;
    out.push({
      path: f.path,
      bytes: f.stat.allocated,
      identity: identityOf(f.stat, f.stat.allocated),
      notes: named ? [] : ['Phone screenshot (PNG without camera metadata).'],
    });
  }
  return out;
}

export async function detectRecordings(ctx: DetectorContext): Promise<Candidate[]> {
  const { p } = ctx;
  const out: Candidate[] = [];
  for (const f of await looseFiles(p)) {
    const name = nfc(f.name);
    if (!VIDEO_EXT.test(name) || !RECORDING_NAME.test(name)) continue;
    out.push({ path: f.path, bytes: f.stat.allocated, identity: identityOf(f.stat, f.stat.allocated) });
  }
  return out;
}

export async function detectArchivesExtracted(ctx: DetectorContext): Promise<Candidate[]> {
  const { p } = ctx;
  const dir = join(p.home, 'Downloads');
  const entries = await p.readdir(dir);
  if (!Array.isArray(entries)) return [];
  const dirs = new Set(entries.filter((e) => e.kind === 'dir').map((e) => nfc(e.name)));
  const out: Candidate[] = [];
  for (const f of await topFiles(p, dir)) {
    if (!/\.zip$/i.test(f.name)) continue;
    const s = nfc(stem(f.name));
    if (!dirs.has(s)) continue;
    out.push({
      path: f.path,
      bytes: f.stat.allocated,
      identity: identityOf(f.stat, f.stat.allocated),
      notes: [`The folder "${s.slice(0, 60)}" next to it looks like its extracted copy.`],
    });
  }
  return out;
}

const BIG_FILE_ROOTS = ['Downloads', 'Desktop', 'Documents', 'Movies'];
const BIG_FILE_SKIP = new Set(['node_modules', '.git', '.venv', 'Library', '.Trash']);

async function walkFiles(
  ctx: DetectorContext,
  roots: string[],
  maxDepth: number,
  visit: (path: string, size: number, stat: Awaited<ReturnType<Platform['lstat']>> & object) => void,
): Promise<void> {
  const { p } = ctx;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    const entries = await p.readdir(dir);
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.kind === 'symlink') continue;
      if (e.kind === 'dir') {
        if (BIG_FILE_SKIP.has(e.name) || e.name.endsWith('.app') || e.name.endsWith('.photoslibrary')) continue;
        await walk(full, depth + 1);
      } else if (e.kind === 'file') {
        const s = await p.lstat(full);
        if (s && s.kind === 'file') visit(full, s.allocated, s);
      }
    }
  };
  for (const r of roots) await walk(join(p.home, r), 1);
}

export async function detectLargeFiles(ctx: DetectorContext): Promise<Candidate[]> {
  const out: Candidate[] = [];
  await walkFiles(ctx, BIG_FILE_ROOTS, 5, (path, size, stat) => {
    if (size >= ctx.rule.minBytes) out.push({ path, bytes: size, identity: identityOf(stat, size) });
  });
  return out;
}

/** Size first, then sha256 of the candidates only. Report-only: results go to ctx.duplicates. */
export async function detectDuplicates(ctx: DetectorContext): Promise<Candidate[]> {
  const bySize = new Map<number, string[]>();
  await walkFiles(ctx, ['Downloads', 'Desktop'], 3, (path, _size, stat) => {
    if (stat.size < ctx.rule.minBytes) return;
    if (isSensitiveName(path)) return;
    if (checkProtected(path, ctx.protection, { insideUserFolders: true }).protected) return;
    const list = bySize.get(stat.size) ?? [];
    list.push(path);
    bySize.set(stat.size, list);
  });
  for (const [size, paths] of bySize) {
    if (paths.length < 2) continue;
    const byHash = new Map<string, string[]>();
    for (const path of paths) {
      const h = await ctx.p.sha256File(path);
      byHash.set(h, [...(byHash.get(h) ?? []), path]);
    }
    for (const group of byHash.values()) if (group.length > 1) ctx.duplicates.push({ bytes: size, paths: group });
  }
  return [];
}
