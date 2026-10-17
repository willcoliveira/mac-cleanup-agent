/** Terminal and Markdown renderings of a scan and of results. */
import type { Results, Scan } from '../core/schemas.js';
import { formatBytes } from '../core/util.js';
import { AREA_TITLES, reportOnly, totalOffered } from './common.js';

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = (s: string) => c('1', s);
export const dim = (s: string) => c('2', s);
export const green = (s: string) => c('32', s);
export const yellow = (s: string) => c('33', s);
export const red = (s: string) => c('31', s);

const riskColor = (r: string) => (r === 'safe' ? green(r) : r === 'review' ? yellow(r) : red(r));

function pad(s: string, n: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, n - visible.length));
}

export function renderTerminal(scan: Scan): string {
  const lines: string[] = [];
  lines.push(bold(`mac-cleanup-agent: ${scan.scan_id}`));
  lines.push(`Free now: ${bold(formatBytes(scan.free.availableBytes))} of ${formatBytes(scan.free.totalBytes)}   Offered: ${bold(formatBytes(totalOffered(scan)))}`);
  lines.push('');
  lines.push(dim(pad('AREA', 34) + pad('SIZE', 10) + pad('ITEMS', 7) + 'RISK'));
  for (const a of scan.areas) {
    lines.push(pad(AREA_TITLES[a.area], 34) + pad(formatBytes(a.bytes), 10) + pad(String(a.items), 7) + riskColor(a.maxRisk));
  }
  const ro = reportOnly(scan);
  if (ro.length) {
    lines.push('');
    lines.push(bold('Report only (never offered):'));
    for (const i of ro.sort((a, b) => b.bytes - a.bytes).slice(0, 8)) lines.push(`  ${pad(formatBytes(i.bytes), 10)}${i.title}`);
  }
  if (scan.protected.length) {
    lines.push('');
    lines.push(bold('Protected:') + ' ' + scan.protected.map((p) => `${p.label} ${formatBytes(p.bytes)}`).join(' · '));
  }
  if (scan.trash.foreignItems) lines.push(`Already in your Trash: ${scan.trash.foreignItems} item(s), ${formatBytes(scan.trash.foreignBytes)} (never emptied by this tool)`);
  if (scan.security.length) lines.push(yellow(`Security findings: ${scan.security.length} (see the report)`));
  for (const w of scan.warnings) lines.push(yellow(`! ${w}`));
  lines.push('');
  lines.push(dim(`Next: mac-cleanup-agent report --run ${scan.scan_id} --format html   ·   approvals init --run ${scan.scan_id}`));
  return lines.join('\n');
}

const mdEscape = (s: string) => s.replace(/[|`*_<>[\]]/g, (ch) => `\\${ch}`);

export function renderMarkdown(scan: Scan, results?: Results | null): string {
  const out: string[] = [];
  out.push(`# Mac cleanup report`);
  out.push('');
  out.push(`- Scan: \`${scan.scan_id}\` (${scan.created_at})`);
  out.push(`- Free space: **${formatBytes(scan.free.availableBytes)}** of ${formatBytes(scan.free.totalBytes)} (${scan.free.metric}, purgeable space not included)`);
  out.push(`- Offered for cleanup: **${formatBytes(totalOffered(scan))}** in ${scan.areas.length} area(s)`);
  out.push(`- Full Disk Access: ${scan.environment.fullDiskAccess ? 'yes' : 'NO (scan incomplete)'} · Backup: ${scan.environment.backup.configured ? 'configured' : '**none**'} · iCloud Desktop & Documents: ${scan.environment.icloudDesktopDocuments}`);
  if (results) {
    out.push('');
    out.push(`## Results`);
    out.push('');
    out.push(`**From ${formatBytes(results.before.availableBytes)} to ${formatBytes(results.after.availableBytes)} free** (${formatBytes(Math.max(0, results.after.availableBytes - results.before.availableBytes))} freed).`);
    out.push(`Moved to Trash: ${results.trashedItems} item(s), ${formatBytes(results.trashedBytes)}. Emptied: ${formatBytes(results.emptiedBytes)}. Skipped: ${results.skipped}. Failed: ${results.failed}.`);
  }
  out.push('');
  out.push(`## Areas`);
  out.push('');
  out.push(`| Area | Size | Items | Risk |`);
  out.push(`|---|---:|---:|---|`);
  for (const a of scan.areas) out.push(`| ${AREA_TITLES[a.area]} | ${formatBytes(a.bytes)} | ${a.items} | ${a.maxRisk} |`);
  for (const a of scan.areas) {
    out.push('');
    out.push(`### ${AREA_TITLES[a.area]}`);
    out.push('');
    out.push(`| Item | Size | Risk | How it comes back |`);
    out.push(`|---|---:|---|---|`);
    for (const i of scan.items.filter((x) => x.area === a.area && x.action.type !== 'report-only').sort((x, y) => y.bytes - x.bytes)) {
      out.push(`| \`${i.id}\` ${mdEscape(i.label)} | ${formatBytes(i.bytes)} | ${i.risk} | ${mdEscape(i.regenerate)} |`);
    }
  }
  const ro = reportOnly(scan);
  if (ro.length) {
    out.push('');
    out.push(`## Report only`);
    out.push('');
    for (const i of ro.sort((a, b) => b.bytes - a.bytes)) out.push(`- ${formatBytes(i.bytes)}: ${mdEscape(i.label)}${i.notes[0] ? ` (${mdEscape(i.notes[0])})` : ''}`);
  }
  if (scan.duplicates.length) {
    out.push('');
    out.push(`## Duplicates`);
    out.push('');
    for (const d of scan.duplicates) out.push(`- ${formatBytes(d.bytes)} each: ${d.labels.map(mdEscape).join(' = ')}`);
  }
  if (scan.security.length) {
    out.push('');
    out.push(`## Security findings`);
    out.push('');
    for (const s of scan.security) out.push(`- \`${s.id}\` ${s.kind}: ${mdEscape(s.label)}. ${mdEscape(s.advice)}`);
  }
  if (scan.protected.length) {
    out.push('');
    out.push(`## Protected (never offered)`);
    out.push('');
    for (const p of scan.protected) out.push(`- ${p.label}: ${formatBytes(p.bytes)}`);
  }
  if (scan.warnings.length) {
    out.push('');
    out.push(`## Warnings`);
    out.push('');
    for (const w of scan.warnings) out.push(`- ${mdEscape(w)}`);
  }
  out.push('');
  return out.join('\n');
}

export function renderResults(r: Results): string {
  const freed = Math.max(0, r.after.availableBytes - r.before.availableBytes);
  return [
    bold(`From ${formatBytes(r.before.availableBytes)} to ${formatBytes(r.after.availableBytes)} free`) + ` (${formatBytes(freed)} freed so far)`,
    `Moved to Trash: ${r.trashedItems} item(s), ${formatBytes(r.trashedBytes)}   Emptied: ${formatBytes(r.emptiedBytes)}   Skipped: ${r.skipped}   Failed: ${r.failed}`,
    r.emptiedBytes === 0 && r.trashedBytes > 0 ? dim(`Space moved to the Trash is freed when you run: mac-cleanup-agent empty --run ${r.scan_id}`) : '',
  ]
    .filter(Boolean)
    .join('\n');
}
