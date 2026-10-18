/**
 * The scan engine: runs the effective rules for the requested profiles and
 * areas, drops anything protected, nested or too small, and produces the
 * inventory (scan.json). Read-only: nothing here changes the disk.
 */
import { join } from 'node:path';
import { DETECTOR_IMPL } from './detectors/index.js';
import { pathCandidate, resetRepoCache, searchCandidates } from './detectors/search.js';
import type { Candidate, DetectorContext, DuplicateGroup } from './detectors/types.js';
import {
  AREAS,
  type AreaId,
  type AreaSummary,
  CONTRACT_VERSION,
  type Item,
  type Profile,
  type Risk,
  Scan,
} from './core/schemas.js';
import { displayLabel, expandHome, isInside, itemId, newScanId } from './core/util.js';
import type { Platform } from './platform/types.js';
import type { Rule } from './rules/schema.js';
import { detectEnvironment } from './safety/environment.js';
import { checkProtected, defaultRoots, type ProtectionContext } from './safety/protected.js';
import { scanSecurity } from './security.js';

const RISK_ORDER: Record<Risk, number> = { safe: 0, review: 1, caution: 2 };

export function maxRisk(a: Risk, b: Risk): Risk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

export interface ScanOptions {
  profiles: Profile[];
  areas: AreaId[];
  rules: Rule[];
  protection: ProtectionContext;
  /** Progress callback (rule id) for the terminal. */
  onRule?: (rule: Rule) => void;
}

async function candidatesFor(ctx: DetectorContext): Promise<Candidate[]> {
  const f = ctx.rule.find;
  if ('paths' in f) {
    const out: Candidate[] = [];
    for (const raw of f.paths) {
      const c = await pathCandidate(ctx.p, expandHome(raw, ctx.p.home));
      if (c) out.push(c);
    }
    return out;
  }
  if ('search' in f) return searchCandidates(ctx);
  return DETECTOR_IMPL[f.detector](ctx);
}

const PROTECTED_SIZED = ['Photos library', 'Mail', 'Messages', 'iCloud Drive (local copy)', 'iPhone/iPad backups', 'Downloaded ML models'];

export async function runScan(p: Platform, opts: ScanOptions): Promise<Scan> {
  resetRepoCache();
  const environment = await detectEnvironment(p);
  const fs = await p.statfs(p.home);
  const now = p.now();
  const scanId = newScanId(now);
  const duplicates: DuplicateGroup[] = [];
  const warnings: string[] = [];
  const items: Item[] = [];
  const takenPaths: string[] = [];

  const wantProfile = (r: Rule) => r.profile === 'common' || opts.profiles.includes(r.profile);
  const wantArea = (r: Rule) => opts.areas.length === 0 || opts.areas.includes(r.area);

  for (const rule of opts.rules.filter((r) => wantProfile(r) && wantArea(r))) {
    opts.onRule?.(rule);
    let candidates: Candidate[];
    try {
      candidates = await candidatesFor({ p, rule, protection: opts.protection, duplicates, warnings });
    } catch (e) {
      warnings.push(`${rule.id}: ${(e as Error).message}`);
      continue;
    }
    for (const found of candidates) {
      // Store the realpath, so `clean` can detect a symlink swapped into the path later.
      const real = found.path ? await p.realpath(found.path) : '';
      if (found.path && !real) continue;
      const c = found.path ? { ...found, path: real as string } : found;
      if (c.path) {
        if (checkProtected(c.path, opts.protection, { insideUserFolders: rule.insideUserFolders }).protected) continue;
        // One owner per byte: skip anything inside (or containing) an item already taken.
        if (takenPaths.some((t) => isInside(c.path, t) || isInside(t, c.path))) continue;
      }
      if (c.bytes < rule.minBytes && rule.action.type !== 'report-only') continue;
      if (c.bytes === 0 && rule.action.type === 'report-only') continue;
      const action = c.action ?? rule.action;
      const risk = c.risk ? maxRisk(rule.risk, c.risk) : rule.risk;
      if (c.path) takenPaths.push(c.path);
      items.push({
        id: itemId(c.path || c.identity.fingerprint || rule.id, c.identity.dev, c.identity.ino, scanId),
        ruleId: rule.id,
        area: rule.area,
        profile: rule.profile,
        risk,
        title: c.title ?? rule.title,
        path: c.path,
        label: c.label ?? (c.path ? displayLabel(c.path, p.home) : rule.title),
        bytes: c.bytes,
        identity: c.identity,
        action,
        regenerate: rule.regenerate,
        notes: [...rule.notes, ...(c.notes ?? [])].slice(0, 10),
        aiClassified: false,
        requiresQuit: rule.requiresQuit,
      });
    }
  }

  const areas: AreaSummary[] = [];
  for (const area of AREAS) {
    const list = items.filter((i) => i.area === area && i.action.type !== 'report-only');
    if (!list.length) continue;
    areas.push({
      area,
      bytes: list.reduce((s, i) => s + i.bytes, 0),
      items: list.length,
      maxRisk: list.reduce<Risk>((r, i) => maxRisk(r, i.risk), 'safe'),
    });
  }
  areas.sort((a, b) => b.bytes - a.bytes);

  const protectedList: Scan['protected'] = [];
  for (const root of defaultRoots(p.home).filter((r) => PROTECTED_SIZED.includes(r.label))) {
    const s = await p.lstat(root.path);
    if (!s) continue;
    protectedList.push({ label: root.label, bytes: (await p.usage(root.path)).bytes });
  }

  const trash = { foreignItems: 0, foreignBytes: 0 };
  const trashEntries = await p.readdir(p.trashRoot);
  if (Array.isArray(trashEntries)) {
    const visible = trashEntries.filter((e) => e.name !== '.DS_Store' && e.name !== '.localized');
    trash.foreignItems = visible.length;
    trash.foreignBytes = visible.length ? (await p.usage(p.trashRoot)).bytes : 0;
  }

  if (environment.icloudDesktopDocuments === 'on') {
    warnings.push('iCloud Desktop & Documents sync is on: files moved to the Trash from Desktop or Documents are also removed from iCloud and your other devices.');
  }
  for (const u of opts.protection.unlocked) warnings.push(`Unlocked for this scan by you: ${displayLabel(u, p.home)}`);
  if (!environment.backup.configured) warnings.push('No Time Machine backup is configured. Emptying the Trash at the end will need an extra confirmation.');

  const scan: Scan = {
    contract_version: CONTRACT_VERSION,
    scan_id: scanId,
    created_at: now.toISOString(),
    profiles: opts.profiles,
    areasRequested: opts.areas,
    environment,
    free: { availableBytes: fs.available, totalBytes: fs.total, metric: 'statfs.f_bavail', at: now.toISOString() },
    areas,
    items,
    protected: protectedList,
    trash,
    security: await scanSecurity(p),
    duplicates: duplicates.map((d) => ({ bytes: d.bytes, labels: d.paths.map((x) => displayLabel(x, p.home)) })),
    warnings,
    unlocked: [...opts.protection.unlocked],
  };
  return Scan.parse(scan);
}

export function runsDirFor(home: string): string {
  return join(home, 'Library/Application Support/mac-cleanup-agent/runs');
}
