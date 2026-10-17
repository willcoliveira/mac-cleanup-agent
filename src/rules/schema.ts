/**
 * Rule catalog schema. Built-in rules live in rules/*.yaml; users add or tune
 * rules in ~/.config/mac-cleanup-agent/rules.yaml. Patterns are plain names and
 * simple globs (`*` and `?`), never regular expressions, so a rule file cannot
 * smuggle in a catastrophic pattern.
 */
import { z } from 'zod';
import { Action, AreaId, Profile, Risk } from '../core/schemas.js';

const SimpleGlob = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !/[[\]{}()|+^$\\]/.test(s), 'only * and ? wildcards are allowed');

const HomePath = z
  .string()
  .min(1)
  .max(300)
  .refine((s) => s === '~' || s.startsWith('~/') || s.startsWith('/'), 'paths are ~, start with ~/ or are absolute')
  .refine((s) => !s.split('/').includes('..'), '".." is not allowed');

export const DETECTORS = [
  'docker',
  'ios-simulators',
  'ios-runtimes',
  'android-avds',
  'android-ndk-old',
  'playwright-old-builds',
  'node-versions-old',
  'homebrew',
  'installers',
  'screenshots',
  'screen-recordings',
  'archives-extracted',
  'large-files',
  'duplicates',
] as const;
export const DetectorId = z.enum(DETECTORS);
export type DetectorId = z.infer<typeof DetectorId>;

export const Find = z.union([
  z.object({ paths: z.array(HomePath).min(1).max(30) }).strict(),
  z
    .object({
      search: z
        .object({
          roots: z.array(HomePath).min(1).max(10),
          names: z.array(SimpleGlob).min(1).max(20),
          kind: z.enum(['dir', 'file']).default('dir'),
          maxDepth: z.number().int().min(1).max(10).default(6),
          /** The match counts only when one of these exists next to it (e.g. package.json). */
          requireSibling: z.array(SimpleGlob).max(10).default([]),
          /** `ignored`: must be ignored by git when inside a repo. `clean-pushed`: also repo clean and pushed. */
          git: z.enum(['any', 'ignored', 'clean-pushed']).default('ignored'),
        })
        .strict(),
    })
    .strict(),
  z.object({ detector: DetectorId }).strict(),
]);
export type Find = z.infer<typeof Find>;

export const Rule = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/),
    profile: Profile,
    area: AreaId,
    title: z.string().min(3).max(120),
    risk: Risk,
    find: Find,
    action: Action.default({ type: 'trash' }),
    regenerate: z.string().min(3).max(300),
    minBytes: z.number().int().nonnegative().default(1_000_000),
    requiresQuit: z.array(z.string().max(80)).max(5).default([]),
    /** Lets a rule offer specific regenerable items inside Documents/Desktop (never the folders themselves). */
    insideUserFolders: z.boolean().default(false),
    notes: z.array(z.string().max(300)).max(5).default([]),
  })
  .strict();
export type Rule = z.infer<typeof Rule>;

export const RuleFile = z.object({ rules: z.array(Rule) }).strict();

export const UserConfig = z
  .object({
    /** Built-in rule ids to switch off. */
    disable: z.array(z.string()).default([]),
    /** Per-rule minimum size overrides, in bytes. */
    minBytes: z.record(z.string(), z.number().int().nonnegative()).default({}),
    /** Extra protected paths (exact folders or files). Can only add protection. */
    protect: z.array(HomePath).default([]),
    /** Extra rules. They may not use `risk: safe` — user rules always ask. */
    rules: z.array(Rule).default([]),
    judge_model: z.enum(['auto', 'opus', 'fable', 'sonnet']).default('auto'),
  })
  .strict();
export type UserConfig = z.infer<typeof UserConfig>;
