/**
 * Best-effort token cost estimate for a plugin run, per phase.
 *
 * Reads ONLY the `usage` and `model` fields of assistant entries in the Claude
 * Code session transcript (and its sub-agent transcripts), streaming line by
 * line; conversation text is never parsed into memory or stored. The transcript
 * format is not a documented API, so anything unexpected yields "unavailable".
 *
 * Figures are API list-price equivalents. On a Pro/Max subscription you don't
 * pay per token; the number shows relative cost between runs and phases.
 */
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

/** USD per million tokens. Source: Anthropic list prices as cached on PRICING_DATE. */
export const PRICING_DATE = '2026-10-06';
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}
const P = (input: number, output: number, cacheRead = input * 0.1): Price => ({ input, output, cacheRead });
export const PRICES: Record<string, Price> = {
  'claude-fable-5-1': P(10, 50, 0.25),
  'claude-fable-5': P(10, 50),
  'claude-opus-5-5': P(4, 20, 0.2),
  'claude-opus-5': P(5, 25),
  'claude-opus-4-8': P(5, 25),
  'claude-opus-4-7': P(5, 25),
  'claude-opus-4-6': P(5, 25),
  'claude-sonnet-5-5': P(2, 10, 0.2),
  'claude-sonnet-5': P(2, 10),
  'claude-sonnet-4-6': P(3, 15),
  'claude-haiku-5-5': P(0.1, 0.5),
  'claude-haiku-4-5': P(1, 5),
};
/** Prompt-cache writes (5-minute TTL) bill at 1.25x the input price. */
const CACHE_WRITE_MULT = 1.25;

export function priceFor(model: string): Price | null {
  const key = Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model === k || model.startsWith(k + '-') || model.startsWith(k + '['));
  return key ? (PRICES[key] as Price) : null;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export function usd(model: string, u: Usage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const m = 1_000_000;
  return (
    ((u.input_tokens ?? 0) * p.input +
      (u.cache_creation_input_tokens ?? 0) * p.input * CACHE_WRITE_MULT +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.output_tokens ?? 0) * p.output) /
    m
  );
}

export interface PhaseMark {
  phase: string;
  at: string;
}

export interface CostRow {
  phase: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number | null;
}

export interface CostReport {
  available: boolean;
  reason?: string;
  pricingDate: string;
  rows: CostRow[];
  totalUsd: number | null;
}

/** Extracts {model, usage, timestamp} from one transcript line without keeping message text. */
export function usageFromLine(line: string): { model: string; usage: Usage; at: string } | null {
  if (!line.includes('"usage"')) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const e = entry as { type?: string; timestamp?: string; message?: { model?: string; usage?: Usage } };
  if (e.type !== 'assistant' || !e.message?.usage || !e.message.model || !e.timestamp) return null;
  const u = e.message.usage;
  return {
    model: e.message.model,
    at: e.timestamp,
    usage: {
      input_tokens: Number(u.input_tokens) || 0,
      output_tokens: Number(u.output_tokens) || 0,
      cache_creation_input_tokens: Number(u.cache_creation_input_tokens) || 0,
      cache_read_input_tokens: Number(u.cache_read_input_tokens) || 0,
    },
  };
}

function phaseAt(marks: PhaseMark[], at: string): string | null {
  let current: string | null = null;
  for (const m of marks) if (m.at <= at) current = m.phase;
  return current;
}

/** Transcript files: the session file plus `<session>/subagents/*.jsonl` when present. */
export function transcriptFiles(transcriptPath: string): string[] {
  const files = [transcriptPath];
  const sub = join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'subagents');
  if (existsSync(sub)) for (const f of readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(join(sub, f));
  return files;
}

export async function estimateCost(transcriptPath: string | null, marks: PhaseMark[], endAt?: string): Promise<CostReport> {
  const base: CostReport = { available: false, pricingDate: PRICING_DATE, rows: [], totalUsd: null };
  if (!transcriptPath || !existsSync(transcriptPath)) return { ...base, reason: 'no Claude Code transcript recorded for this run (standalone CLI runs cost no tokens)' };
  if (marks.length === 0) return { ...base, reason: 'no phase marks recorded for this run' };
  const sorted = [...marks].sort((a, b) => a.at.localeCompare(b.at));
  const rows = new Map<string, CostRow>();
  for (const file of transcriptFiles(transcriptPath)) {
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      const u = usageFromLine(line);
      if (!u) continue;
      if (endAt && u.at > endAt) continue;
      const phase = phaseAt(sorted, u.at);
      if (!phase) continue;
      const key = `${phase}\0${u.model}`;
      const row = rows.get(key) ?? { phase, model: u.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0 };
      row.inputTokens += u.usage.input_tokens ?? 0;
      row.outputTokens += u.usage.output_tokens ?? 0;
      row.cacheReadTokens += u.usage.cache_read_input_tokens ?? 0;
      row.cacheWriteTokens += u.usage.cache_creation_input_tokens ?? 0;
      const cost = usd(u.model, u.usage);
      row.usd = row.usd === null || cost === null ? null : row.usd + cost;
      rows.set(key, row);
    }
  }
  const list = [...rows.values()];
  if (!list.length) return { ...base, reason: 'the transcript had no usage entries inside the run window' };
  const totalUsd = list.some((r) => r.usd === null) ? null : list.reduce((s, r) => s + (r.usd ?? 0), 0);
  return { available: true, pricingDate: PRICING_DATE, rows: list, totalUsd };
}
