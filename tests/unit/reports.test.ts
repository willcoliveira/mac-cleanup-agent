import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Scan } from '../../src/core/schemas.js';
import { buildArtifactPayload, renderArtifact } from '../../src/report/artifact.js';
import { renderHtml } from '../../src/report/html.js';
import { buildSummary } from '../../src/report/summary.js';
import { renderMarkdown } from '../../src/report/text.js';
import { loadBuiltinRules } from '../../src/rules/loader.js';
import { runScan } from '../../src/scan.js';
import { estimateCost, priceFor, usageFromLine, usd } from '../../src/cost.js';
import { applyOrganize, classify, loadOrganizeRules, planOrganize } from '../../src/organize.js';
import { buildStandardHome } from '../fixtures/standard-home.js';
import { type Fixture, makeFixture } from '../helpers.js';

describe('reports', () => {
  let fx: Fixture;
  let scan: Scan;
  beforeAll(async () => {
    fx = makeFixture();
    buildStandardHome(fx);
    fx.file('Downloads/Screenshot <img src=x onerror=alert(1)>.png', 300_000);
    scan = await runScan(fx.p, { profiles: ['developer', 'qa', 'pm', 'creator'], areas: [], rules: loadBuiltinRules(), protection: fx.protection });
  });
  afterAll(() => fx.cleanup());

  it('the shareable artifact payload carries no names or paths at all', () => {
    const payload = buildArtifactPayload(scan, null);
    const json = JSON.stringify(payload);
    expect(json).not.toMatch(/[/~]/);
    for (const name of ['demo-app', 'Invoice', 'Fatura', 'Passaporte', 'Screenshot', 'sample', 'Downloads']) expect(json).not.toContain(name);
    const html = renderArtifact(payload);
    for (const name of ['demo-app', 'Invoice', 'Passaporte', fx.home]) expect(html).not.toContain(name);
  });

  it('the local HTML report escapes hostile filenames and blocks all external loads', () => {
    const html = renderHtml(scan);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('noindex');
    expect(html).not.toMatch(/<script/i);
  });

  it('the Claude summary is compact, marks untrusted fields and never includes paths', () => {
    const summary = buildSummary(scan);
    const json = JSON.stringify(summary);
    expect(summary.untrusted_fields).toContain('label');
    expect(json).not.toContain(fx.home);
    expect(json.length).toBeLessThan(40_000);
    for (const a of summary.areas) expect(a.top.length).toBeLessThanOrEqual(5);
  });

  it('markdown escapes table syntax', () => {
    expect(renderMarkdown(scan)).toContain('\\<img src=x onerror=alert(1)\\>');
  });
});

describe('cost estimate', () => {
  it('prices known models and reads only usage fields', () => {
    expect(priceFor('claude-opus-5-5')?.input).toBe(4);
    expect(priceFor('claude-sonnet-5-5[1m]')?.output).toBe(10);
    expect(usd('claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(0.6);
    expect(usd('unknown-model', { input_tokens: 1 })).toBeNull();
    const line = JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'SECRET' }], usage: { input_tokens: 10, output_tokens: 5 } } });
    const u = usageFromLine(line);
    expect(u).toEqual({ model: 'claude-sonnet-5-5', at: '2026-01-01T00:00:01Z', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
    expect(JSON.stringify(u)).not.toContain('SECRET');
  });

  it('splits usage by phase and degrades gracefully', async () => {
    const fx = makeFixture();
    const t = join(fx.home, 'session.jsonl');
    const entry = (at: string, model: string, out: number) => JSON.stringify({ type: 'assistant', timestamp: at, message: { model, usage: { input_tokens: 1000, output_tokens: out } } });
    writeFileSync(t, [entry('2026-01-01T00:00:01Z', 'claude-opus-5-5', 100), 'not json', entry('2026-01-01T00:05:00Z', 'claude-haiku-5-5', 50)].join('\n'));
    const r = await estimateCost(t, [{ phase: 'scan', at: '2026-01-01T00:00:00Z' }, { phase: 'deep', at: '2026-01-01T00:04:00Z' }]);
    expect(r.available).toBe(true);
    expect(r.rows.map((x) => x.phase).sort()).toEqual(['deep', 'scan']);
    expect((await estimateCost(null, [])).available).toBe(false);
    fx.cleanup();
  });
});

describe('organize', () => {
  it('classifies multilingual names, accent-insensitively', () => {
    const rules = loadOrganizeRules('/nonexistent');
    expect(classify('Fatura_Servicos_2026.03.pdf', rules)).toBe('Invoices and Receipts');
    expect(classify('Invoice_June.pdf', rules)).toBe('Invoices and Receipts');
    expect(classify('Passaporte - Sample.pdf', rules)).toBe('Personal and IDs');
    expect(classify('Declaração IRS.pdf', rules)).toBe('Taxes');
    expect(classify('notes.pdf', rules)).toBe('Unsorted');
  });

  it('never overwrites, skips secrets, and moves exactly the plan', async () => {
    const fx = makeFixture();
    buildStandardHome(fx);
    fx.file('Documents/Organized/Invoices and Receipts/Invoice_2026-01.pdf', 0, 'existing');
    fx.file('Downloads/backup-codes.pdf', 0, 'fake');
    const plan = await planOrganize(fx.p, join(fx.home, 'Downloads'), join(fx.home, 'Documents/Organized'), loadOrganizeRules('/nonexistent'));
    expect(plan.skipped.map((s) => s.label)).toEqual(expect.arrayContaining(['~/Downloads/Invoice_2026-01.pdf', '~/Downloads/backup-codes.pdf']));
    const r = applyOrganize(join(fx.home, 'plans'), plan);
    expect(r.failed).toEqual([]);
    expect(readFileSync(join(fx.home, 'Documents/Organized/Invoices and Receipts/Invoice_2026-01.pdf'), 'utf8')).toBe('existing');
    expect(existsSync(join(fx.home, 'Documents/Organized/Invoices and Receipts/Fatura_Servicos_2026.03.pdf'))).toBe(true);
    expect(existsSync(join(fx.home, 'Downloads/backup-codes.pdf'))).toBe(true);
    fx.cleanup();
  });
});
