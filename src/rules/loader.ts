import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { Rule, RuleFile, UserConfig } from './schema.js';

/** rules/ ships next to dist/ in the npm package and at the repo root in a checkout. */
export function builtinRulesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, '../rules'), resolve(here, '../../rules')]) {
    if (existsSync(join(candidate, 'developer.yaml'))) return candidate;
  }
  throw new Error('built-in rules not found (expected a rules/ folder next to the CLI)');
}

export function loadRuleFile(path: string): Rule[] {
  const parsed = RuleFile.safeParse(parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${path}: ${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid rule file'}`);
  }
  return parsed.data.rules;
}

export function loadBuiltinRules(dir = builtinRulesDir()): Rule[] {
  const rules: Rule[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yaml')).sort()) {
    rules.push(...loadRuleFile(join(dir, f)));
  }
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) throw new Error(`duplicate built-in rule id ${r.id}`);
    seen.add(r.id);
  }
  return rules;
}

export function userConfigPath(home: string): string {
  return join(home, '.config/mac-cleanup-agent/rules.yaml');
}

export function loadUserConfig(home: string): UserConfig {
  const path = userConfigPath(home);
  if (!existsSync(path)) return UserConfig.parse({});
  const parsed = UserConfig.safeParse(parse(readFileSync(path, 'utf8')) ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${path}: ${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid config'}`);
  }
  return parsed.data;
}

/**
 * Merges built-in rules with the user's config. Users may add rules, disable
 * built-in ones and change size thresholds, but never weaken protection: user
 * rules are forced to at least `review` risk and can't reuse a built-in id.
 */
export function effectiveRules(builtin: Rule[], user: UserConfig): Rule[] {
  const ids = new Set(builtin.map((r) => r.id));
  const out: Rule[] = [];
  for (const r of builtin) {
    if (user.disable.includes(r.id)) continue;
    const minBytes = user.minBytes[r.id];
    out.push(minBytes === undefined ? r : { ...r, minBytes });
  }
  for (const r of user.rules) {
    if (ids.has(r.id)) throw new Error(`user rule ${r.id} reuses a built-in id; pick a new id (e.g. user.${r.id})`);
    out.push({ ...r, risk: r.risk === 'safe' ? 'review' : r.risk, notes: [...r.notes, 'from your rules.yaml'] });
  }
  return out;
}
