/**
 * The shareable report (a claude.ai Artifact). It is built from a typed payload
 * of catalog enums and numbers ONLY — no labels, no titles, no paths — so file
 * and folder names (passport scans, invoices, client names) can never leave the
 * machine in it. The CLI builds it; the skill publishes the file verbatim.
 */
import { z } from 'zod';
import { AreaId, Risk, type Results, type Scan } from '../core/schemas.js';
import { formatBytes } from '../core/util.js';
import { AREA_TITLES } from './common.js';
import { PAGE_CSS } from './html.js';

export const ArtifactPayload = z
  .object({
    generated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    freeBefore: z.number().int().nonnegative(),
    freeAfter: z.number().int().nonnegative().nullable(),
    diskTotal: z.number().int().nonnegative(),
    offered: z.number().int().nonnegative(),
    emptied: z.number().int().nonnegative(),
    areas: z.array(z.object({ area: AreaId, bytes: z.number().int().nonnegative(), items: z.number().int().nonnegative(), maxRisk: Risk }).strict()),
    protectedBytes: z.number().int().nonnegative(),
    securityFindings: z.number().int().nonnegative(),
    backupConfigured: z.boolean(),
  })
  .strict();
export type ArtifactPayload = z.infer<typeof ArtifactPayload>;

export function buildArtifactPayload(scan: Scan, results?: Results | null): ArtifactPayload {
  return ArtifactPayload.parse({
    generated: scan.created_at.slice(0, 10),
    freeBefore: scan.free.availableBytes,
    freeAfter: results ? results.after.availableBytes : null,
    diskTotal: scan.free.totalBytes,
    offered: scan.areas.reduce((s, a) => s + a.bytes, 0),
    emptied: results?.emptiedBytes ?? 0,
    areas: scan.areas.map((a) => ({ area: a.area, bytes: a.bytes, items: a.items, maxRisk: a.maxRisk })),
    protectedBytes: scan.protected.reduce((s, p) => s + p.bytes, 0),
    securityFindings: scan.security.length,
    backupConfigured: scan.environment.backup.configured,
  });
}

/** Renders only from the payload. Area titles come from the catalog, never from scan data. */
export function renderArtifact(payload: ArtifactPayload): string {
  const p = ArtifactPayload.parse(payload);
  const max = Math.max(1, ...p.areas.map((a) => a.bytes));
  const headline =
    p.freeAfter !== null
      ? `From ${formatBytes(p.freeBefore)} to ${formatBytes(p.freeAfter)} free`
      : `${formatBytes(p.offered)} can be freed`;
  const rows = p.areas
    .map(
      (a) => `<tr><td>${AREA_TITLES[a.area]}<div class="bar"><span style="width:${((a.bytes / max) * 100).toFixed(1)}%"></span></div></td><td class="num">${formatBytes(a.bytes)}</td><td class="num">${a.items}</td><td class="risk ${a.maxRisk}">${a.maxRisk}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Mac Cleanup Summary</title><style>${PAGE_CSS}</style></head><body><main>
<h1>${headline}</h1><div class="muted">Mac cleanup summary · ${p.generated} · areas and sizes only</div>
<div class="kpis"><div class="kpi"><span class="muted">Free before</span><b>${formatBytes(p.freeBefore)}</b></div>
<div class="kpi"><span class="muted">Free after</span><b>${p.freeAfter !== null ? formatBytes(p.freeAfter) : '—'}</b></div>
<div class="kpi"><span class="muted">Offered</span><b>${formatBytes(p.offered)}</b></div>
<div class="kpi"><span class="muted">Disk</span><b>${formatBytes(p.diskTotal)}</b></div></div>
<table><tr><th>Area</th><th>Size</th><th>Items</th><th>Risk</th></tr>${rows}</table>
<p class="muted">Protected data left untouched: ${formatBytes(p.protectedBytes)} · Security findings: ${p.securityFindings} · Backup: ${p.backupConfigured ? 'configured' : 'none'}</p>
<p class="muted">Made with mac-cleanup-agent. No file or folder names are included in this summary.</p>
</main></body></html>`;
}
