/**
 * Run storage. Runs live outside the working directory, in
 * ~/Library/Application Support/mac-cleanup-agent/runs/<scan_id>/, so file
 * inventories (which contain real paths) never land inside a git repository.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { Approvals, CONTRACT_VERSION, ManifestEntry, Results, Scan } from './core/schemas.js';
import { sha256 } from './core/util.js';

export class RunStore {
  constructor(readonly root: string) {}

  dir(scanId: string): string {
    if (!/^scan_[0-9]{8}T[0-9]{6}_[a-f0-9]{6}$/.test(scanId)) throw new Error(`invalid run id "${scanId}"`);
    return join(this.root, scanId);
  }

  saveScan(scan: Scan): string {
    const dir = this.dir(scan.scan_id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'scan.json');
    writeFileSync(path, JSON.stringify(scan, null, 2) + '\n', { mode: 0o600 });
    return path;
  }

  /** Loads a scan, verifying the contract version. Returns the parsed scan and the sha256 of its exact bytes. */
  loadScan(scanId: string): { scan: Scan; sha: string } {
    const raw = readFileSync(join(this.dir(scanId), 'scan.json'));
    const json = JSON.parse(raw.toString('utf8')) as { contract_version?: unknown };
    if (json.contract_version !== CONTRACT_VERSION) {
      throw new Error(`run ${scanId} uses contract version ${String(json.contract_version)}; this CLI speaks ${CONTRACT_VERSION}. Scan again.`);
    }
    return { scan: Scan.parse(json), sha: sha256(raw) };
  }

  latest(): string | null {
    if (!existsSync(this.root)) return null;
    const runs = readdirSync(this.root).filter((n) => n.startsWith('scan_') && existsSync(join(this.root, n, 'scan.json'))).sort();
    return runs.at(-1) ?? null;
  }

  list(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter((n) => n.startsWith('scan_')).sort();
  }

  approvalsPath(scanId: string): string {
    return join(this.dir(scanId), 'approvals.yaml');
  }

  /** Writes an approvals template with every decision off, annotated for hand editing. */
  initApprovals(scan: Scan, sha: string): string {
    const path = this.approvalsPath(scan.scan_id);
    const header = [
      `# Approvals for ${scan.scan_id}. Set an area or an item to true to approve it.`,
      '# An item set to false overrides its area. Nothing is removed until you run',
      `#   mac-cleanup-agent clean --run ${scan.scan_id} --yes`,
      '# and nothing is permanently deleted until you run `empty` and confirm.',
      '#',
      ...scan.areas.map((a) => `#   area ${a.area}: ${a.items} item(s), risk up to ${a.maxRisk}`),
      '#',
      ...scan.items
        .filter((i) => i.action.type !== 'report-only')
        .map((i) => `#   ${i.id}  [${i.risk}] ${i.area}  ${i.label.replace(/\n/g, ' ')}`),
      '',
    ].join('\n');
    const body: Approvals = {
      contract_version: CONTRACT_VERSION,
      scan_id: scan.scan_id,
      scan_sha256: sha,
      areas: Object.fromEntries(scan.areas.map((a) => [a.area, false])),
      items: {},
    };
    writeFileSync(path, header + stringify(body), { mode: 0o600 });
    return path;
  }

  loadApprovals(scanId: string): Approvals {
    const path = this.approvalsPath(scanId);
    if (!existsSync(path)) throw new Error(`no approvals for ${scanId}: run \`mac-cleanup-agent approvals init --run ${scanId}\``);
    return Approvals.parse(parse(readFileSync(path, 'utf8')));
  }

  saveApprovals(a: Approvals): void {
    writeFileSync(this.approvalsPath(a.scan_id), stringify(Approvals.parse(a)), { mode: 0o600 });
  }

  manifestPath(scanId: string): string {
    return join(this.dir(scanId), 'manifest.jsonl');
  }

  /** Append + fsync per entry, so an interrupted run still has an exact record of what moved. */
  appendManifest(scanId: string, entry: ManifestEntry): void {
    const path = this.manifestPath(scanId);
    const fd = openSync(path, 'a', 0o600);
    try {
      appendFileSync(fd, JSON.stringify(ManifestEntry.parse(entry)) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  readManifest(scanId: string): ManifestEntry[] {
    const path = this.manifestPath(scanId);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => ManifestEntry.parse(JSON.parse(l)));
  }

  saveResults(r: Results): void {
    writeFileSync(join(this.dir(r.scan_id), 'results.json'), JSON.stringify(Results.parse(r), null, 2) + '\n', { mode: 0o600 });
  }

  loadResults(scanId: string): Results | null {
    const path = join(this.dir(scanId), 'results.json');
    return existsSync(path) ? Results.parse(JSON.parse(readFileSync(path, 'utf8'))) : null;
  }

  writeFile(scanId: string, name: string, content: string): string {
    if (!/^[a-z0-9.-]+$/.test(name)) throw new Error('invalid output file name');
    const path = join(this.dir(scanId), name);
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  }

  lockPath(): string {
    return join(this.root, '.lock');
  }

  /** One mutating run at a time. The plugin's hooks also deny other deletes while this exists. */
  acquireLock(): () => void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const path = this.lockPath();
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, 'utf8').trim());
      let alive = false;
      try {
        if (pid > 0) {
          process.kill(pid, 0);
          alive = true;
        }
      } catch {
        alive = false;
      }
      if (alive) throw new Error(`another mac-cleanup-agent run is in progress (pid ${pid})`);
      unlinkSync(path);
    }
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
    };
    // Node does not emit 'exit' when killed by an unhandled signal, so a Ctrl-C mid-clean
    // would leave the lock behind (and the plugin's hook would block every delete).
    const onSignal = (sig: NodeJS.Signals) => {
      release();
      process.exit(sig === 'SIGINT' ? 130 : 143);
    };
    process.once('exit', release);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('SIGHUP', onSignal);
    return () => {
      release();
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGHUP', onSignal);
    };
  }
}
