/**
 * organize: sorts loose documents (PDFs, Office files, spreadsheets) from a
 * folder like Downloads into category folders, by filename keywords in several
 * languages ("fatura", "invoice", "factura", "rechnung" ...).
 *
 * It is a separate run from cleanup (moves invalidate scan inventories), it
 * never overwrites (hard link + unlink, which fails atomically if the target
 * exists), never touches secret-looking files, and writes a dry-run plan first.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { displayLabel, nfc } from './core/util.js';
import type { Platform } from './platform/types.js';
import { builtinRulesDir } from './rules/loader.js';
import { globToRegExp } from './detectors/search.js';
import { isSensitiveName } from './security.js';

export const OrganizeRules = z
  .object({
    extensions: z.array(z.string().regex(/^\.[a-z0-9]{1,12}$/)).min(1),
    fallback: z.string().min(1).max(60),
    categories: z
      .array(
        z
          .object({
            folder: z.string().min(1).max(60).regex(/^[^/\\:]+$/),
            keywords: z.array(z.string().min(2).max(40)).default([]),
            globs: z.array(z.string().min(1).max(80).refine((s) => !/[[\]{}()|+^$\\]/.test(s))).default([]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type OrganizeRules = z.infer<typeof OrganizeRules>;

export function loadOrganizeRules(home: string): OrganizeRules {
  const user = join(home, '.config/mac-cleanup-agent/organize.yaml');
  const path = existsSync(user) ? user : join(builtinRulesDir(), 'organize', 'organize.yaml');
  return OrganizeRules.parse(parse(readFileSync(path, 'utf8')));
}

/** First matching category wins; keywords match on accent-insensitive lowercase text. */
export function classify(name: string, rules: OrganizeRules): string {
  const fold = (s: string) => nfc(s).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  const n = fold(name);
  for (const c of rules.categories) {
    if (c.keywords.some((k) => n.includes(fold(k)))) return c.folder;
    if (c.globs.some((g) => globToRegExp(fold(g)).test(n))) return c.folder;
  }
  return rules.fallback;
}

export interface OrganizeMove {
  from: string;
  to: string;
  category: string;
  label: string;
}

export interface OrganizePlan {
  id: string;
  source: string;
  dest: string;
  moves: OrganizeMove[];
  skipped: Array<{ label: string; reason: string }>;
}

export async function planOrganize(p: Platform, source: string, dest: string, rules: OrganizeRules): Promise<OrganizePlan> {
  const entries = await p.readdir(source);
  if (entries === 'denied') throw new Error('macOS denied access to the source folder (Full Disk Access needed)');
  if (!entries) throw new Error('source folder not found');
  const id = `org_${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}_${randomBytes(3).toString('hex')}`;
  const moves: OrganizeMove[] = [];
  const skipped: OrganizePlan['skipped'] = [];
  const taken = new Set<string>();
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.kind !== 'file') continue;
    const name = e.name;
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    if (!rules.extensions.includes(ext)) continue;
    const from = join(source, name);
    if (isSensitiveName(from)) {
      skipped.push({ label: displayLabel(from, p.home), reason: 'looks like a secret or key; left in place' });
      continue;
    }
    const category = classify(name, rules);
    const to = join(dest, category, name);
    if (existsSync(to) || taken.has(to)) {
      skipped.push({ label: displayLabel(from, p.home), reason: 'a file with the same name already exists there' });
      continue;
    }
    taken.add(to);
    moves.push({ from, to, category, label: displayLabel(from, p.home) });
  }
  return { id, source, dest, moves, skipped };
}

export function savePlan(dir: string, plan: OrganizePlan): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${plan.id}.json`);
  writeFileSync(path, JSON.stringify(plan, null, 2), { mode: 0o600 });
  return path;
}

export function loadPlan(dir: string, id: string): OrganizePlan {
  if (!/^org_[0-9T]{15}_[a-f0-9]{6}$/.test(id)) throw new Error('invalid organize plan id');
  return JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as OrganizePlan;
}

export function planDigest(plan: OrganizePlan): string {
  return createHash('sha256').update(JSON.stringify(plan.moves)).digest('hex').slice(0, 12);
}

/** Applies a saved plan. link() fails if the target exists, so nothing is ever overwritten. */
export function applyOrganize(dir: string, plan: OrganizePlan): { moved: number; failed: Array<{ label: string; reason: string }> } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = join(dir, `${plan.id}.moved.jsonl`);
  let moved = 0;
  const failed: Array<{ label: string; reason: string }> = [];
  for (const m of plan.moves) {
    try {
      mkdirSync(join(m.to, '..'), { recursive: true });
      linkSync(m.from, m.to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      failed.push({ label: m.label, reason: code === 'EEXIST' ? 'target exists; not overwritten' : code === 'EXDEV' ? 'destination is on another disk' : (e as Error).message.slice(0, 120) });
      continue;
    }
    // The link exists; only now remove the original, and log the move once both names agree.
    unlinkSync(m.from);
    appendFileSync(log, JSON.stringify({ from: m.from, to: m.to }) + '\n', { mode: 0o600 });
    moved++;
  }
  return { moved, failed };
}
