/**
 * Self-contained HTML report: one offline file, no scripts, no external
 * requests (CSP default-src 'none'), noindex. Every value is escaped; labels
 * are filenames and therefore untrusted.
 */
import type { Results, Scan } from '../core/schemas.js';
import { formatBytes } from '../core/util.js';
import { AREA_TITLES, reportOnly, totalOffered } from './common.js';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

export const PAGE_CSS = `
:root{--bg:#fbfbfd;--fg:#1d1d1f;--muted:#6e6e73;--card:#fff;--line:#e5e5ea;--accent:#0a7cff;--safe:#1f9d55;--review:#b7791f;--caution:#c53030;--bar:#0a7cff22}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#111114;--fg:#f5f5f7;--muted:#a1a1a6;--card:#1c1c1f;--line:#2c2c30;--accent:#4aa3ff;--safe:#48bb78;--review:#ecc94b;--caution:#fc8181;--bar:#4aa3ff33}}
:root[data-theme="dark"]{--bg:#111114;--fg:#f5f5f7;--muted:#a1a1a6;--card:#1c1c1f;--line:#2c2c30;--accent:#4aa3ff;--safe:#48bb78;--review:#ecc94b;--caution:#fc8181;--bar:#4aa3ff33}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}h1{font-size:28px;margin:0 0 4px}h2{font-size:19px;margin:32px 0 10px}
.muted{color:var(--muted)}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:20px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}.kpi b{display:block;font-size:24px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.risk{font-weight:600}.risk.safe{color:var(--safe)}.risk.review{color:var(--review)}.risk.caution{color:var(--caution)}
.bar{height:6px;background:var(--bar);border-radius:3px;margin-top:4px}.bar>span{display:block;height:100%;background:var(--accent);border-radius:3px}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}.warn{border-left:3px solid var(--review);padding:6px 12px;background:var(--card);margin:8px 0}
.wrap{word-break:break-all}`;

export function renderHtml(scan: Scan, results?: Results | null): string {
  const total = totalOffered(scan);
  const max = Math.max(1, ...scan.areas.map((a) => a.bytes));
  const kpi = (label: string, value: string) => `<div class="kpi"><span class="muted">${esc(label)}</span><b>${esc(value)}</b></div>`;
  const rows = scan.areas
    .map(
      (a) => `<tr><td>${esc(AREA_TITLES[a.area])}<div class="bar"><span style="width:${((a.bytes / max) * 100).toFixed(1)}%"></span></div></td><td class="num">${esc(formatBytes(a.bytes))}</td><td class="num">${a.items}</td><td class="risk ${a.maxRisk}">${a.maxRisk}</td></tr>`,
    )
    .join('');
  const detail = scan.areas
    .map((a) => {
      const items = scan.items.filter((i) => i.area === a.area && i.action.type !== 'report-only').sort((x, y) => y.bytes - x.bytes);
      return `<h2>${esc(AREA_TITLES[a.area])}</h2><table><tr><th>Item</th><th>Size</th><th>Risk</th><th>How it comes back</th></tr>${items
        .map(
          (i) => `<tr><td class="wrap">${esc(i.label)}<br><code>${esc(i.id)}</code>${i.notes.map((n) => `<div class="muted">${esc(n)}</div>`).join('')}</td><td class="num">${esc(formatBytes(i.bytes))}</td><td class="risk ${i.risk}">${i.risk}</td><td>${esc(i.regenerate)}</td></tr>`,
        )
        .join('')}</table>`;
    })
    .join('');
  const ro = reportOnly(scan).sort((a, b) => b.bytes - a.bytes);
  const resultsBlock = results
    ? `<div class="kpis">${kpi('Before', formatBytes(results.before.availableBytes))}${kpi('After', formatBytes(results.after.availableBytes))}${kpi('Moved to Trash', formatBytes(results.trashedBytes))}${kpi('Emptied', formatBytes(results.emptiedBytes))}</div>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="robots" content="noindex,nofollow">
<title>Mac cleanup report</title><style>${PAGE_CSS}</style></head><body><main>
<h1>Mac cleanup report</h1><div class="muted">${esc(scan.scan_id)} · ${esc(scan.created_at)} · macOS ${esc(scan.environment.macos)}</div>
<div class="kpis">${kpi('Free now', formatBytes(scan.free.availableBytes))}${kpi('Offered for cleanup', formatBytes(total))}${kpi('Disk size', formatBytes(scan.free.totalBytes))}${kpi('Backup', scan.environment.backup.configured ? 'Configured' : 'None')}</div>
${resultsBlock}
${scan.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
<h2>Areas</h2><table><tr><th>Area</th><th>Size</th><th>Items</th><th>Risk</th></tr>${rows}</table>
${detail}
${ro.length ? `<h2>Report only</h2><table><tr><th>Item</th><th>Size</th></tr>${ro.map((i) => `<tr><td class="wrap">${esc(i.label)}${i.notes.map((n) => `<div class="muted">${esc(n)}</div>`).join('')}</td><td class="num">${esc(formatBytes(i.bytes))}</td></tr>`).join('')}</table>` : ''}
${scan.duplicates.length ? `<h2>Duplicates</h2><table><tr><th>Copies</th><th>Size each</th></tr>${scan.duplicates.map((d) => `<tr><td class="wrap">${d.labels.map(esc).join('<br>')}</td><td class="num">${esc(formatBytes(d.bytes))}</td></tr>`).join('')}</table>` : ''}
${scan.security.length ? `<h2>Security findings</h2><table><tr><th>Finding</th><th>Advice</th></tr>${scan.security.map((s) => `<tr><td class="wrap">${esc(s.label)}<br><code>${esc(s.id)} · ${esc(s.kind)}</code></td><td>${esc(s.advice)}</td></tr>`).join('')}</table>` : ''}
${scan.protected.length ? `<h2>Protected (never offered)</h2><table>${scan.protected.map((p) => `<tr><td>${esc(p.label)}</td><td class="num">${esc(formatBytes(p.bytes))}</td></tr>`).join('')}</table>` : ''}
<p class="muted">Generated locally by mac-cleanup-agent. Nothing in this report left your Mac.</p>
</main></body></html>`;
}
