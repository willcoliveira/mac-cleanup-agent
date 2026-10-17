/**
 * Everything the tool needs from the operating system goes through this
 * interface, so tests can run the whole scan → approve → clean → empty flow
 * against a synthetic HOME (see src/platform/fake.ts) without touching the
 * real disk, the real Trash, Docker or the simulators.
 */
export interface FileStat {
  kind: 'dir' | 'file' | 'symlink' | 'other';
  dev: number;
  ino: number;
  /** Apparent size in bytes. */
  size: number;
  /** Allocated size in bytes (st_blocks * 512): what freeing it actually returns. */
  allocated: number;
  mtimeMs: number;
  mode: number;
  uid: number;
}

export interface DirEntry {
  name: string;
  kind: FileStat['kind'];
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TrashResult {
  path: string;
  ok: boolean;
  /** Where the item ended up. Trash renames on name collision, so this is the only reliable record. */
  resulting?: string;
  error?: string;
}

export interface Usage {
  /** Allocated bytes, without crossing into other filesystems (no mount points, no simulator volumes). */
  bytes: number;
  /** True when part of the tree could not be read. */
  partial: boolean;
}

export interface Platform {
  readonly home: string;
  readonly uid: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Root of the user's Trash (`~/.Trash` on a real Mac). */
  readonly trashRoot: string;
  now(): Date;
  lstat(path: string): Promise<FileStat | null>;
  /** `null` when missing, `'denied'` when macOS privacy protection (TCC) blocks it. */
  readdir(path: string): Promise<DirEntry[] | 'denied' | null>;
  realpath(path: string): Promise<string | null>;
  usage(path: string): Promise<Usage>;
  statfs(path: string): Promise<{ available: number; total: number }>;
  exec(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>;
  trash(paths: string[]): Promise<TrashResult[]>;
  /** Permanent delete. Only `empty` calls this, and only for this run's own Trash entries. */
  removeTree(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  sha256File(path: string): Promise<string>;
  /** Spotlight metadata values for the given keys (null when absent). */
  mdls(path: string, keys: string[]): Promise<Record<string, string | null>>;
}
