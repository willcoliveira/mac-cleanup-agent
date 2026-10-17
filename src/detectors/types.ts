import type { Action, Identity, Risk } from '../core/schemas.js';
import type { Platform } from '../platform/types.js';
import type { Rule } from '../rules/schema.js';
import type { ProtectionContext } from '../safety/protected.js';

/** What a detector proposes. The scan engine turns it into an inventory Item. */
export interface Candidate {
  /** Absolute path; empty for virtual items cleaned by a tool (docker images, simulator runtimes). */
  path: string;
  bytes: number;
  identity: Identity;
  title?: string;
  label?: string;
  action?: Action;
  notes?: string[];
  /** Detectors may only raise risk, never lower it. */
  risk?: Risk;
}

export interface DuplicateGroup {
  bytes: number;
  paths: string[];
}

export interface DetectorContext {
  p: Platform;
  rule: Rule;
  protection: ProtectionContext;
  /** Side channel for report-only findings that are not inventory items. */
  duplicates: DuplicateGroup[];
  warnings: string[];
}

export type Detector = (ctx: DetectorContext) => Promise<Candidate[]>;
