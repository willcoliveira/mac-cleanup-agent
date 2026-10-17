/**
 * The compact view Claude reads in quick mode (Tier 0 → Tier 2 hand-off).
 * Size-capped: top items per area only, notes trimmed, labels marked untrusted.
 * Claude refers to items by id; it never needs a path.
 */
import type { Scan } from '../core/schemas.js';
import { CONTRACT_VERSION } from '../core/schemas.js';
import { formatBytes } from '../core/util.js';
import { AREA_TITLES, reportOnly, totalOffered } from './common.js';

export interface SummaryOptions {
  topPerArea?: number;
}

export function buildSummary(scan: Scan, opts: SummaryOptions = {}) {
  const top = opts.topPerArea ?? 5;
  return {
    contract_version: CONTRACT_VERSION,
    scan_id: scan.scan_id,
    untrusted_fields: ['label', 'title', 'notes'],
    free: formatBytes(scan.free.availableBytes),
    free_bytes: scan.free.availableBytes,
    offered_total: formatBytes(totalOffered(scan)),
    environment: {
      fullDiskAccess: scan.environment.fullDiskAccess,
      backup: scan.environment.backup.configured,
      icloudDesktopDocuments: scan.environment.icloudDesktopDocuments,
      runningApps: scan.environment.runningApps,
    },
    areas: scan.areas.map((a) => {
      const items = scan.items.filter((i) => i.area === a.area && i.action.type !== 'report-only').sort((x, y) => y.bytes - x.bytes);
      return {
        area: a.area,
        title: AREA_TITLES[a.area],
        size: formatBytes(a.bytes),
        bytes: a.bytes,
        items: a.items,
        maxRisk: a.maxRisk,
        top: items.slice(0, top).map((i) => ({
          id: i.id,
          title: i.title.slice(0, 80),
          label: i.label.slice(0, 100),
          size: formatBytes(i.bytes),
          risk: i.risk,
          action: i.action.type === 'tool' ? i.action.tool : i.action.type,
          regenerate: i.regenerate.slice(0, 140),
          notes: i.notes.slice(0, 2).map((n) => n.slice(0, 140)),
          requiresQuit: i.requiresQuit,
          aiClassified: i.aiClassified,
        })),
        more: Math.max(0, items.length - top),
      };
    }),
    reportOnly: reportOnly(scan)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 10)
      .map((i) => ({ id: i.id, title: i.title.slice(0, 80), label: i.label.slice(0, 100), size: formatBytes(i.bytes), notes: i.notes.slice(0, 1) })),
    protected: scan.protected.map((p) => ({ label: p.label, size: formatBytes(p.bytes) })),
    trash: { otherItems: scan.trash.foreignItems, otherSize: formatBytes(scan.trash.foreignBytes) },
    security: scan.security.slice(0, 10).map((s) => ({ id: s.id, kind: s.kind, label: s.label, fixable: Boolean(s.fix) })),
    securityTotal: scan.security.length,
    duplicates: scan.duplicates.length,
    warnings: scan.warnings,
  };
}
