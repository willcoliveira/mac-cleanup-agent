/**
 * The contract between the CLI, the Claude Code plugin skills and the tests.
 *
 * Every JSON document the CLI writes carries `contract_version`. Skills pin the
 * value in references/output-contract.md and abort on a mismatch, because a
 * globally installed CLI on PATH can shadow the plugin's own `bin/` shim.
 *
 * Design rule M1: Claude never handles paths, only inventory ids. Each scan item
 * gets an opaque id bound to its filesystem identity; approvals reference ids;
 * `clean` and `empty` take no path arguments.
 */
import { z } from 'zod';

export const CONTRACT_VERSION = 1;

/** Catalog areas. An area is always one of these ids — never a path segment. */
export const AREAS = [
  'package-caches',
  'build-artifacts',
  'browser-test-binaries',
  'test-reports',
  'ios-simulators',
  'ios-runtimes',
  'android-emulators',
  'android-sdk',
  'docker',
  'xcode',
  'homebrew',
  'node-versions',
  'app-caches',
  'installers',
  'screenshots',
  'screen-recordings',
  'archives',
  'media-intermediates',
  'large-files',
  'duplicates',
  'trash',
] as const;
export const AreaId = z.enum(AREAS);
export type AreaId = z.infer<typeof AreaId>;

export const PROFILES = ['developer', 'qa', 'pm', 'creator', 'common'] as const;
export const Profile = z.enum(PROFILES);
export type Profile = z.infer<typeof Profile>;

/**
 * safe:    regenerable with no user effort (caches).
 * review:  regenerable but costs time or a download (node_modules, simulators).
 * caution: may hold the user's own data; never pre-approved (recordings, archives).
 */
export const Risk = z.enum(['safe', 'review', 'caution']);
export type Risk = z.infer<typeof Risk>;

/** Tool-native cleaners. Never `rm`: the only permanent delete is `empty`. */
export const TOOLS = [
  'npm-cache-clean',
  'uv-cache-clean',
  'docker-image-prune',
  'docker-builder-prune',
  'simctl-delete-device',
  'simctl-delete-unavailable',
  'simctl-runtime-delete',
  'avd-delete',
  'brew-cleanup',
] as const;
export const ToolId = z.enum(TOOLS);
export type ToolId = z.infer<typeof ToolId>;

export const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('trash') }).strict(),
  z.object({ type: z.literal('tool'), tool: ToolId, arg: z.string().max(200).optional() }).strict(),
  z.object({ type: z.literal('report-only') }).strict(),
]);
export type Action = z.infer<typeof Action>;

/** Filesystem identity an approval is bound to (TOCTOU defence). */
export const Identity = z
  .object({
    kind: z.enum(['dir', 'file', 'virtual']),
    dev: z.number().int().nonnegative(),
    ino: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    mtimeMs: z.number().nonnegative(),
    /** For virtual items (docker images, simulator devices): a stable fingerprint. */
    fingerprint: z.string().max(200).optional(),
  })
  .strict();
export type Identity = z.infer<typeof Identity>;

export const Item = z
  .object({
    id: z.string().regex(/^i_[a-f0-9]{12}$/),
    ruleId: z.string().min(1).max(80),
    area: AreaId,
    profile: Profile,
    risk: Risk,
    title: z.string().max(200),
    /** Absolute path for path items; empty for virtual items. Lives in scan.json only. */
    path: z.string(),
    /** `~`-relative display label, truncated. Untrusted: may contain hostile text. */
    label: z.string().max(160),
    bytes: z.number().int().nonnegative(),
    identity: Identity,
    action: Action,
    regenerate: z.string().max(300),
    notes: z.array(z.string().max(300)).max(10),
    /** Set when an AI sub-agent (deep mode) proposed the item; such items default to "ask". */
    aiClassified: z.boolean().default(false),
    requiresQuit: z.array(z.string().max(80)).max(5).default([]),
  })
  .strict();
export type Item = z.infer<typeof Item>;

export const AreaSummary = z
  .object({ area: AreaId, bytes: z.number().int().nonnegative(), items: z.number().int().nonnegative(), maxRisk: Risk })
  .strict();
export type AreaSummary = z.infer<typeof AreaSummary>;

export const FreeSpace = z
  .object({
    /** statfs f_bavail * f_bsize of the Data volume: what the user can write. Purgeable space is not included. */
    availableBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    metric: z.literal('statfs.f_bavail'),
    at: z.string(),
  })
  .strict();
export type FreeSpace = z.infer<typeof FreeSpace>;

export const SecurityFinding = z
  .object({
    id: z.string().regex(/^s_[a-f0-9]{12}$/),
    kind: z.enum(['secret-filename', 'key-file', 'loose-permissions']),
    label: z.string().max(160),
    path: z.string(),
    mode: z.string().regex(/^[0-7]{3,4}$/).optional(),
    advice: z.string().max(300),
    /** Only permission tightening is ever offered as a fix. */
    fix: z.object({ type: z.literal('chmod'), mode: z.enum(['600', '700']) }).strict().optional(),
  })
  .strict();
export type SecurityFinding = z.infer<typeof SecurityFinding>;

export const Environment = z
  .object({
    macos: z.string(),
    arch: z.string(),
    fullDiskAccess: z.boolean(),
    backup: z.object({ configured: z.boolean(), latest: z.string().nullable() }).strict(),
    icloudDesktopDocuments: z.enum(['on', 'off', 'unknown']),
    runningApps: z.array(z.string()),
  })
  .strict();
export type Environment = z.infer<typeof Environment>;

export const Scan = z
  .object({
    contract_version: z.literal(CONTRACT_VERSION),
    scan_id: z.string().regex(/^scan_[0-9]{8}T[0-9]{6}_[a-f0-9]{6}$/),
    created_at: z.string(),
    profiles: z.array(Profile),
    areasRequested: z.array(AreaId),
    environment: Environment,
    free: FreeSpace,
    areas: z.array(AreaSummary),
    items: z.array(Item),
    /** Space the tool can see but will never offer (Photos, Mail, Messages, ...). Labels only. */
    protected: z.array(z.object({ label: z.string(), bytes: z.number().int().nonnegative() }).strict()),
    /** Other things already in the Trash: reported, never deleted by this tool. */
    trash: z.object({ foreignItems: z.number().int().nonnegative(), foreignBytes: z.number().int().nonnegative() }).strict(),
    security: z.array(SecurityFinding),
    duplicates: z.array(
      z.object({ bytes: z.number().int().nonnegative(), labels: z.array(z.string().max(160)).min(2) }).strict(),
    ),
    warnings: z.array(z.string()),
    /** Exact paths a human unlocked for this scan; clean honours the same set. */
    unlocked: z.array(z.string()).default([]),
  })
  .strict();
export type Scan = z.infer<typeof Scan>;

export const Approvals = z
  .object({
    contract_version: z.literal(CONTRACT_VERSION),
    scan_id: z.string(),
    /** sha256 of the exact scan.json bytes these approvals were made against. */
    scan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** Approve every item of an area at once. */
    areas: z.partialRecord(AreaId, z.boolean()).default({}),
    /** Per-item decisions; an explicit `false` here overrides an area-level `true`. */
    items: z.record(z.string().regex(/^i_[a-f0-9]{12}$/), z.boolean()).default({}),
    /** Items whose required apps the user confirmed are quit. */
    note: z.string().max(500).optional(),
  })
  .strict();
export type Approvals = z.infer<typeof Approvals>;

export const ManifestEntry = z
  .object({
    id: z.string(),
    area: AreaId,
    op: z.enum(['trash', 'tool', 'skip', 'empty', 'empty-skip']),
    status: z.enum(['ok', 'skipped', 'failed']),
    reason: z.string().max(300).optional(),
    original: z.string().optional(),
    resulting: z.string().optional(),
    dev: z.number().int().optional(),
    ino: z.number().int().optional(),
    bytes: z.number().int().nonnegative(),
    at: z.string(),
  })
  .strict();
export type ManifestEntry = z.infer<typeof ManifestEntry>;

export const Results = z
  .object({
    contract_version: z.literal(CONTRACT_VERSION),
    scan_id: z.string(),
    before: FreeSpace,
    after: FreeSpace,
    trashedBytes: z.number().int().nonnegative(),
    trashedItems: z.number().int().nonnegative(),
    emptiedBytes: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();
export type Results = z.infer<typeof Results>;
