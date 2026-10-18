/**
 * mac-cleanup-agent CLI. Every command works without Claude; the plugin skills
 * call the same commands and read their --json output.
 *
 * Exit codes: 0 ok · 1 error · 2 bad usage · 3 Full Disk Access missing ·
 * 4 needs a human confirmation that was not given.
 */
import { createInterface } from 'node:readline/promises';
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Command, Option } from 'commander';
import { AREAS, AreaId, PROFILES, type Profile } from '../core/schemas.js';
import { formatBytes } from '../core/util.js';
import { RealPlatform } from '../platform/real.js';
import type { Platform } from '../platform/types.js';
import { effectiveRules, loadBuiltinRules, loadUserConfig, loadRuleFile, userConfigPath } from '../rules/loader.js';
import { RunStore } from '../runs.js';
import { runScan, runsDirFor } from '../scan.js';
import { detectEnvironment, fdaGuidance, hasFullDiskAccess, refuseRoot, terminalFromEnv } from '../safety/environment.js';
import { type ProtectionContext, validateUnlock } from '../safety/protected.js';
import { buildSummary } from '../report/summary.js';
import { renderMarkdown, renderResults, renderTerminal, bold, dim, yellow, red, green } from '../report/text.js';
import { renderHtml } from '../report/html.js';
import { buildArtifactPayload, renderArtifact } from '../report/artifact.js';
import { executeClean, isApproved, planClean, verifyApprovals, computeResults } from '../clean.js';
import { emptyConfirmationPhrase, executeEmpty, NO_BACKUP_PHRASE, planEmpty } from '../empty.js';
import { inspect, propose } from '../inspect.js';
import { applyOrganize, loadOrganizeRules, loadPlan, planOrganize, savePlan } from '../organize.js';
import { applyChmodFix, scanSecurity } from '../security.js';
import { estimateCost, type PhaseMark } from '../cost.js';

const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
})();

class ExitError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

const platform: Platform = new RealPlatform();
const store = () => new RunStore(runsDirFor(platform.home));

function protection(unlocked: string[] = []): ProtectionContext {
  const user = loadUserConfig(platform.home);
  return {
    home: platform.home,
    trashRoot: platform.trashRoot,
    runsDir: runsDirFor(platform.home),
    userProtect: user.protect.map((p) => (p.startsWith('~/') ? platform.home + p.slice(1) : p)),
    unlocked: new Set(unlocked),
  };
}

function preflight(): void {
  const root = refuseRoot(platform);
  if (root) throw new ExitError(root, 1);
}

async function requireFda(): Promise<void> {
  if (!(await hasFullDiskAccess(platform))) throw new ExitError(fdaGuidance(terminalFromEnv(platform.env)), 3);
}

function resolveRun(run: string | undefined): string {
  const id = run && run !== 'latest' ? run : store().latest();
  if (!id) throw new ExitError('no scan yet: run `mac-cleanup-agent scan` first', 2);
  return id;
}

function print(json: boolean, data: unknown, text: () => string): void {
  process.stdout.write((json ? JSON.stringify(data, null, 2) : text()) + '\n');
}

async function confirm(question: string, phrase: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question}\nType "${phrase}" to continue: `);
    return answer.trim() === phrase;
  } finally {
    rl.close();
  }
}

function listOption(value: string, allowed: readonly string[], what: string): string[] {
  const items = value.split(',').map((s) => s.trim()).filter(Boolean);
  for (const i of items) if (!allowed.includes(i)) throw new ExitError(`unknown ${what} "${i}" (one of: ${allowed.join(', ')})`, 2);
  return items;
}

/** Records this Claude session's transcript for `cost` (set by the plugin's hook via env). */
function phaseFile(scanId: string): string {
  return join(store().dir(scanId), 'phases.jsonl');
}

const program = new Command();
program
  .name('mac-cleanup-agent')
  .description('Free up disk space on your Mac safely: scan → report → approve → clean → results.')
  .version(VERSION)
  .showHelpAfterError();

program
  .command('doctor')
  .description('Check Full Disk Access, backup, iCloud sync and running apps')
  .option('--json', 'machine-readable output')
  .action(async (o: { json?: boolean }) => {
    const env = await detectEnvironment(platform);
    const fs = await platform.statfs(platform.home);
    const root = refuseRoot(platform);
    const data = { contract_version: 1, ...env, rootRefused: Boolean(root), freeBytes: fs.available, totalBytes: fs.total, judgeModel: loadUserConfig(platform.home).judge_model };
    print(Boolean(o.json), data, () =>
      [
        bold('mac-cleanup-agent doctor'),
        `macOS ${env.macos} (${env.arch})`,
        `Free space:        ${formatBytes(fs.available)} of ${formatBytes(fs.total)}`,
        `Full Disk Access:  ${env.fullDiskAccess ? green('yes') : red('no: scans are refused until it is granted')}`,
        `Backup:            ${env.backup.configured ? green('configured') + (env.backup.latest ? dim(` (latest ${env.backup.latest})`) : '') : yellow('none: emptying the Trash will need an extra confirmation')}`,
        `iCloud Desktop & Documents: ${env.icloudDesktopDocuments}`,
        `Running apps:      ${env.runningApps.length ? env.runningApps.join(', ') : 'none of the watched apps'}`,
        root ? red(root) : '',
        env.fullDiskAccess ? '' : '\n' + fdaGuidance(terminalFromEnv(platform.env)),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  });

program
  .command('scan')
  .description('Scan for reclaimable space (read-only). Requires Full Disk Access.')
  .addOption(new Option('--profile <list>', `profiles: ${PROFILES.filter((p) => p !== 'common').join(',')}`).default('developer,qa,pm,creator'))
  .option('--area <list>', `limit to areas: ${AREAS.join(',')}`)
  .option('--json', 'print the full scan JSON')
  .option('--summary', 'print the compact summary JSON (what the plugin reads)')
  .action(async (o: { profile: string; area?: string; json?: boolean; summary?: boolean }) => {
    preflight();
    await requireFda();
    const profiles = listOption(o.profile, PROFILES, 'profile') as Profile[];
    const areas = o.area ? (listOption(o.area, AREAS, 'area') as AreaId[]) : [];
    const user = loadUserConfig(platform.home);
    const rules = effectiveRules(loadBuiltinRules(), user);
    const quiet = Boolean(o.json || o.summary) || !process.stderr.isTTY;
    // Unlocks are typed by a human in `unlock`, and apply to this one scan only.
    const unlockFile = join(runsDirFor(platform.home), 'unlocked.jsonl');
    const unlocked = existsSync(unlockFile) ? readFileSync(unlockFile, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { path: string }).path) : [];
    if (existsSync(unlockFile)) unlinkSync(unlockFile);
    const scan = await runScan(platform, {
      profiles,
      areas,
      rules,
      protection: protection(unlocked),
      onRule: quiet ? undefined : (r) => process.stderr.write(dim(`  scanning ${r.title}…\n`)),
    });
    const s = store();
    s.saveScan(scan);
    appendFileSync(phaseFile(scan.scan_id), JSON.stringify({ phase: 'scan', at: scan.created_at }) + '\n', { mode: 0o600 });
    if (o.summary) print(true, buildSummary(scan), () => '');
    else print(Boolean(o.json), scan, () => renderTerminal(scan));
  });

program
  .command('report')
  .description('Write the report for a scan (terminal, md, html, json, artifact)')
  .option('--run <id>', 'scan id (default: latest)')
  .option('--format <list>', 'terminal,md,html,json,artifact', 'terminal,md,html')
  .action(async (o: { run?: string; format: string }) => {
    const id = resolveRun(o.run);
    const s = store();
    const { scan } = s.loadScan(id);
    const results = s.loadResults(id);
    const formats = listOption(o.format, ['terminal', 'md', 'html', 'json', 'artifact'], 'format');
    const written: string[] = [];
    for (const f of formats) {
      if (f === 'terminal') process.stdout.write(renderTerminal(scan) + '\n' + (results ? '\n' + renderResults(results) + '\n' : ''));
      if (f === 'md') written.push(s.writeFile(id, 'report.md', renderMarkdown(scan, results)));
      if (f === 'html') written.push(s.writeFile(id, 'report.html', renderHtml(scan, results)));
      if (f === 'json') written.push(s.writeFile(id, 'report.json', JSON.stringify(buildSummary(scan), null, 2)));
      if (f === 'artifact') written.push(s.writeFile(id, 'artifact.html', renderArtifact(buildArtifactPayload(scan, results))));
    }
    for (const w of written) process.stdout.write(`${dim('wrote')} ${w}\n`);
  });

const approvals = program.command('approvals').description('Create, change and show approvals for a scan');
approvals
  .command('init')
  .description('Write approvals.yaml with every decision off')
  .option('--run <id>', 'scan id (default: latest)')
  .action((o: { run?: string }) => {
    const id = resolveRun(o.run);
    const s = store();
    const { scan, sha } = s.loadScan(id);
    process.stdout.write(s.initApprovals(scan, sha) + '\n');
  });
approvals
  .command('set')
  .description('Approve (or reject) areas or items: --area docker=true --item i_abc=false')
  .option('--run <id>', 'scan id (default: latest)')
  .option('--area <decision...>', 'area=true|false')
  .option('--item <decision...>', 'item id=true|false')
  .option('--json', 'machine-readable output')
  .action((o: { run?: string; area?: string[]; item?: string[]; json?: boolean }) => {
    const id = resolveRun(o.run);
    const s = store();
    const { scan, sha } = s.loadScan(id);
    if (!existsSync(s.approvalsPath(id))) s.initApprovals(scan, sha);
    const a = s.loadApprovals(id);
    if (a.scan_sha256 !== sha) throw new ExitError('approvals no longer match scan.json (hash mismatch). Scan again.', 1);
    const parse = (d: string) => {
      const m = d.match(/^([^=]+)=(true|false)$/);
      if (!m) throw new ExitError(`expected key=true|false, got "${d}"`, 2);
      return [m[1] as string, m[2] === 'true'] as const;
    };
    for (const d of o.area ?? []) {
      const [k, v] = parse(d);
      const area = AreaId.safeParse(k);
      if (!area.success) throw new ExitError(`unknown area ${k}`, 2);
      a.areas[area.data] = v;
    }
    for (const d of o.item ?? []) {
      const [k, v] = parse(d);
      if (!scan.items.some((i) => i.id === k)) throw new ExitError(`unknown item ${k}`, 2);
      a.items[k] = v;
    }
    s.saveApprovals(a);
    const approved = scan.items.filter((i) => isApproved(i, a));
    print(Boolean(o.json), { approvedItems: approved.length, approvedBytes: approved.reduce((x, i) => x + i.bytes, 0) }, () => `${approved.length} item(s) approved, ${formatBytes(approved.reduce((x, i) => x + i.bytes, 0))}`);
  });
approvals
  .command('veto')
  .description('Remove items from the delete set (the judge agent may only do this)')
  .option('--run <id>', 'scan id (default: latest)')
  .requiredOption('--item <ids...>', 'item ids to veto')
  .action((o: { run?: string; item: string[] }) => {
    const id = resolveRun(o.run);
    const s = store();
    const a = s.loadApprovals(id);
    for (const i of o.item) {
      if (!/^i_[a-f0-9]{12}$/.test(i)) throw new ExitError(`invalid item id ${i}`, 2);
      a.items[i] = false;
    }
    s.saveApprovals(a);
    process.stdout.write(`vetoed ${o.item.length} item(s)\n`);
  });
approvals
  .command('show')
  .description('Show what is approved')
  .option('--run <id>', 'scan id (default: latest)')
  .option('--json', 'machine-readable output')
  .action((o: { run?: string; json?: boolean }) => {
    const id = resolveRun(o.run);
    const s = store();
    const { scan } = s.loadScan(id);
    const a = s.loadApprovals(id);
    const approved = scan.items.filter((i) => isApproved(i, a));
    print(
      Boolean(o.json),
      { scan_id: id, items: approved.map((i) => ({ id: i.id, area: i.area, risk: i.risk, bytes: i.bytes, title: i.title, aiClassified: i.aiClassified })) },
      () => [`${approved.length} approved item(s), ${formatBytes(approved.reduce((x, i) => x + i.bytes, 0))}:`, ...approved.map((i) => `  ${i.id}  ${formatBytes(i.bytes).padEnd(9)} [${i.risk}] ${i.label}`)].join('\n'),
    );
  });

program
  .command('clean')
  .description('Move approved items to the Trash (dry run unless --yes). Takes no paths: only approved inventory ids.')
  .option('--run <id>', 'scan id (default: latest)')
  .option('--yes', 'actually do it')
  .option('--max-age <hours>', 'refuse scans older than this', '24')
  .option('--json', 'machine-readable output')
  .action(async (o: { run?: string; yes?: boolean; maxAge: string; json?: boolean }) => {
    preflight();
    const id = resolveRun(o.run);
    const s = store();
    const { scan, sha } = s.loadScan(id);
    const a = s.loadApprovals(id);
    verifyApprovals(scan, sha, a, platform.now(), Number(o.maxAge));
    const plan = await planClean(platform, scan, a);
    const bytes = plan.selected.reduce((x, i) => x + i.bytes, 0);
    if (!o.yes) {
      print(
        Boolean(o.json),
        { dryRun: true, items: plan.selected.map((i) => ({ id: i.id, area: i.area, bytes: i.bytes, action: i.action })), blocked: plan.blocked.map((b) => ({ id: b.item.id, reason: b.reason })), bytes },
        () =>
          [
            bold(`Dry run: ${plan.selected.length} item(s), ${formatBytes(bytes)} would be cleaned`),
            ...plan.selected.map((i) => `  ${formatBytes(i.bytes).padEnd(9)} ${i.action.type === 'tool' ? `[${i.action.tool}] ` : ''}${i.label}`),
            ...plan.blocked.map((b) => yellow(`  blocked: ${b.item.label} (${b.reason})`)),
            dim(`Run again with --yes to move these to the Trash.`),
          ].join('\n'),
      );
      return;
    }
    appendFileSync(phaseFile(id), JSON.stringify({ phase: 'clean', at: platform.now().toISOString() }) + '\n', { mode: 0o600 });
    const results = await executeClean(platform, s, plan, protection(), {
      onItem: o.json ? undefined : (item, e) => process.stdout.write(`${e.status === 'ok' ? green('✓') : yellow('•')} ${item.label}${e.reason ? dim(` (${e.reason})`) : ''}\n`),
    });
    print(Boolean(o.json), results, () => renderResults(results));
  });

program
  .command('empty')
  .description("Permanently delete ONLY this run's items from the Trash (needs a typed human confirmation)")
  .option('--run <id>', 'scan id (default: latest)')
  .option('--yes', 'non-interactive confirmation (the plugin asks you in Claude Code’s permission dialog)')
  .option('--ack-no-backup', 'acknowledge there is no backup (non-interactive only)')
  .option('--json', 'machine-readable output')
  .action(async (o: { run?: string; yes?: boolean; ackNoBackup?: boolean; json?: boolean }) => {
    preflight();
    const id = resolveRun(o.run);
    const s = store();
    const { scan } = s.loadScan(id);
    const plan = planEmpty(s, id);
    if (!plan.entries.length) {
      process.stdout.write('Nothing from this run is waiting in the Trash.\n');
      return;
    }
    const env = await detectEnvironment(platform);
    const tty = Boolean(process.stdin.isTTY);
    if (tty) {
      const ok = await confirm(
        `${bold(`Permanently delete ${plan.entries.length} item(s), ${formatBytes(plan.bytes)}, that this run moved to the Trash.`)}\nOther things in your Trash are not touched. This cannot be undone.`,
        emptyConfirmationPhrase(plan.entries.length),
      );
      if (!ok) throw new ExitError('not confirmed; nothing deleted', 4);
      if (!env.backup.configured) {
        const ack = await confirm(yellow('There is no Time Machine backup on this Mac.'), NO_BACKUP_PHRASE);
        if (!ack) throw new ExitError('not confirmed; nothing deleted', 4);
      }
    } else {
      if (!o.yes) throw new ExitError(`refusing without a human confirmation: run it in a terminal, or pass --yes (the plugin gates this behind Claude Code's permission dialog)`, 4);
      if (!env.backup.configured && !o.ackNoBackup) throw new ExitError('no backup is configured: pass --ack-no-backup after the user has confirmed it', 4);
    }
    appendFileSync(phaseFile(id), JSON.stringify({ phase: 'empty', at: platform.now().toISOString() }) + '\n', { mode: 0o600 });
    const results = await executeEmpty(platform, s, scan, plan);
    print(Boolean(o.json), results, () => renderResults(results));
  });

program
  .command('results')
  .description('Show before/after free space for a run')
  .option('--run <id>', 'scan id (default: latest)')
  .option('--json', 'machine-readable output')
  .action(async (o: { run?: string; json?: boolean }) => {
    const id = resolveRun(o.run);
    const s = store();
    const { scan } = s.loadScan(id);
    const r = await computeResults(platform, s, scan);
    print(Boolean(o.json), r, () => renderResults(r));
  });

program
  .command('audit')
  .description('Re-check a run without changing anything: moved items, Trash entries, protected paths')
  .option('--run <id>', 'scan id (default: latest)')
  .option('--json', 'machine-readable output')
  .action(async (o: { run?: string; json?: boolean }) => {
    const id = resolveRun(o.run);
    const s = store();
    const entries = s.readManifest(id);
    const checks: Array<{ id: string; area: string; state: string; bytes: number }> = [];
    for (const e of entries.filter((x) => x.op === 'trash' && x.status === 'ok')) {
      const emptied = entries.some((x) => x.op === 'empty' && x.status === 'ok' && x.resulting === e.resulting);
      const inTrash = e.resulting ? Boolean(await platform.lstat(e.resulting)) : false;
      const original = e.original ? Boolean(await platform.lstat(e.original)) : false;
      checks.push({ id: e.id, area: e.area, state: emptied ? 'emptied' : inTrash ? 'in-trash' : original ? 'restored' : 'gone', bytes: e.bytes });
    }
    print(Boolean(o.json), { scan_id: id, checks }, () => [`Audit of ${id}:`, ...checks.map((c) => `  ${c.id}  ${c.state.padEnd(9)} ${formatBytes(c.bytes)}`)].join('\n'));
  });

program
  .command('inspect')
  .description('Deep mode: list what is inside a folder (names, sizes, dates; never contents). Output is untrusted.')
  .argument('<path>', 'absolute folder path inside your home folder')
  .option('--run <id>', 'scan id (default: latest)')
  .option('--top <n>', 'entries to show', '20')
  .action(async (path: string, o: { run?: string; top: string }) => {
    preflight();
    await requireFda();
    const id = resolveRun(o.run);
    const result = await inspect(platform, store(), id, path, protection(), Math.min(50, Number(o.top) || 20));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });

program
  .command('propose')
  .description('Deep mode: add an inspected entry to the scan as an AI-classified item (needs per-item approval)')
  .option('--run <id>', 'scan id (default: latest)')
  .requiredOption('--entry <id>', 'entry id from inspect (x_…)')
  .requiredOption('--area <area>', 'catalog area')
  .requiredOption('--reason <text>', 'why it looks reclaimable (shown to the user as untrusted)')
  .action(async (o: { run?: string; entry: string; area: string; reason: string }) => {
    const id = resolveRun(o.run);
    const area = AreaId.safeParse(o.area);
    if (!area.success) throw new ExitError(`unknown area ${o.area}`, 2);
    const item = await propose(platform, store(), id, o.entry, area.data, o.reason, protection());
    process.stdout.write(JSON.stringify({ id: item.id, area: item.area, bytes: item.bytes, risk: item.risk, aiClassified: true }) + '\n');
  });

program
  .command('unlock')
  .description('Allow ONE exact protected path to be scanned for this run (human-only; asks in the terminal)')
  .argument('<path>', 'exact absolute path')
  .action(async (path: string) => {
    preflight();
    const why = validateUnlock(path, protection());
    if (why) throw new ExitError(why, 2);
    if (!process.stdin.isTTY) throw new ExitError('unlock only works in an interactive terminal, typed by you', 4);
    const first = await confirm(`Unlock ${path} so rules may offer items inside it?`, 'UNLOCK');
    const second = first && (await confirm('Are you sure? Protected data is usually personal.', 'YES I AM SURE'));
    if (!second) throw new ExitError('not unlocked', 4);
    const file = join(runsDirFor(platform.home), 'unlocked.jsonl');
    appendFileSync(file, JSON.stringify({ path, at: platform.now().toISOString() }) + '\n', { mode: 0o600 });
    process.stdout.write(`Unlocked for the next scan only: ${path}\n`);
  });

program
  .command('organize')
  .description('Sort loose documents into category folders (dry run unless --apply)')
  .option('--dir <path>', 'folder to organize', '~/Downloads')
  .option('--dest <path>', 'where category folders go', '~/Documents/Organized')
  .option('--apply <planId>', 'apply a plan created by a previous dry run')
  .option('--json', 'machine-readable output')
  .action(async (o: { dir: string; dest: string; apply?: string; json?: boolean }) => {
    preflight();
    const home = platform.home;
    const expand = (p: string) => (p.startsWith('~/') ? home + p.slice(1) : p);
    const dir = join(runsDirFor(home), 'organize');
    if (o.apply) {
      const plan = loadPlan(dir, o.apply);
      const r = applyOrganize(dir, plan);
      print(Boolean(o.json), r, () => [`Moved ${r.moved} file(s).`, ...r.failed.map((f) => yellow(`  not moved: ${f.label} (${f.reason})`))].join('\n'));
      return;
    }
    await requireFda();
    const plan = await planOrganize(platform, expand(o.dir), expand(o.dest), loadOrganizeRules(home));
    const path = savePlan(dir, plan);
    const byCat = new Map<string, number>();
    for (const m of plan.moves) byCat.set(m.category, (byCat.get(m.category) ?? 0) + 1);
    print(Boolean(o.json), { plan: plan.id, path, moves: plan.moves.length, byCategory: Object.fromEntries(byCat), skipped: plan.skipped }, () =>
      [
        bold(`Plan ${plan.id}: ${plan.moves.length} file(s) → ${o.dest}`),
        ...[...byCat.entries()].map(([c, n]) => `  ${String(n).padStart(4)}  ${c}`),
        ...plan.skipped.map((s) => yellow(`  skipped: ${s.label} (${s.reason})`)),
        dim(`Review ${path}, then: mac-cleanup-agent organize --apply ${plan.id}`),
      ].join('\n'),
    );
  });

program
  .command('security')
  .description('List security findings; --fix applies one approved permission fix')
  .option('--run <id>', 'use the findings from this scan (default: fresh check)')
  .option('--fix <findingId>', 'tighten permissions for one finding')
  .option('--yes', 'confirm the fix')
  .option('--json', 'machine-readable output')
  .action(async (o: { run?: string; fix?: string; yes?: boolean; json?: boolean }) => {
    preflight();
    const findings = o.run ? store().loadScan(resolveRun(o.run)).scan.security : await scanSecurity(platform);
    if (o.fix) {
      const f = findings.find((x) => x.id === o.fix);
      if (!f) throw new ExitError(`unknown finding ${o.fix}`, 2);
      if (!o.yes) throw new ExitError(`would run chmod ${f.fix?.mode ?? '(no fix)'} on ${f.label}; add --yes to apply`, 4);
      process.stdout.write(`${f.label}: ${await applyChmodFix(platform, f)}\n`);
      return;
    }
    print(Boolean(o.json), findings.map(({ path: _p, ...rest }) => rest), () => (findings.length ? findings.map((f) => `${f.id}  ${f.kind.padEnd(18)} ${f.label}\n    ${dim(f.advice)}`).join('\n') : 'No security findings.'));
  });

const rules = program.command('rules').description('List or validate cleanup rules');
rules
  .command('list')
  .option('--json', 'machine-readable output')
  .action((o: { json?: boolean }) => {
    const list = effectiveRules(loadBuiltinRules(), loadUserConfig(platform.home));
    print(Boolean(o.json), list, () => list.map((r) => `${r.id.padEnd(30)} ${r.profile.padEnd(10)} ${r.risk.padEnd(8)} ${r.title}`).join('\n'));
  });
rules
  .command('validate')
  .argument('[file]', 'a rules file (default: built-in rules and your rules.yaml)')
  .action((file?: string) => {
    if (file) {
      const n = loadRuleFile(file).length;
      process.stdout.write(`${file}: ${n} valid rule(s)\n`);
      return;
    }
    const builtin = loadBuiltinRules();
    const list = effectiveRules(builtin, loadUserConfig(platform.home));
    process.stdout.write(`${builtin.length} built-in rule(s) valid; ${list.length} effective (${userConfigPath(platform.home)})\n`);
  });

program
  .command('phase')
  .description('Mark the start of a phase for per-phase cost (used by the plugin)')
  .option('--run <id>', 'scan id (default: latest)')
  .requiredOption('--name <phase>', 'preflight|scan|analysis|deep|approvals|clean|empty|results')
  .action((o: { run?: string; name: string }) => {
    if (!/^[a-z-]{2,20}$/.test(o.name)) throw new ExitError('invalid phase name', 2);
    const id = resolveRun(o.run);
    appendFileSync(phaseFile(id), JSON.stringify({ phase: o.name, at: platform.now().toISOString() }) + '\n', { mode: 0o600 });
  });

program
  .command('cost')
  .description('Estimate the token cost of a plugin run, per phase (API list-price equivalent)')
  .option('--run <id>', 'scan id (default: latest)')
  .option('--transcript <path>', 'Claude Code transcript (default: the one the plugin recorded)')
  .option('--json', 'machine-readable output')
  .action(async (o: { run?: string; transcript?: string; json?: boolean }) => {
    const id = resolveRun(o.run);
    const dir = store().dir(id);
    const marks: PhaseMark[] = existsSync(phaseFile(id)) ? readFileSync(phaseFile(id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as PhaseMark) : [];
    let transcript = o.transcript ?? null;
    const session = join(dir, 'session.json');
    if (!transcript && existsSync(session)) transcript = (JSON.parse(readFileSync(session, 'utf8')) as { transcript_path?: string }).transcript_path ?? null;
    const report = await estimateCost(transcript, marks);
    if (report.available) store().writeFile(id, 'cost.json', JSON.stringify(report, null, 2));
    print(Boolean(o.json), report, () =>
      report.available
        ? [bold(`Estimated cost: ${report.totalUsd === null ? 'n/a' : `$${report.totalUsd.toFixed(2)}`}`) + dim(` (API list prices as of ${report.pricingDate}; subscriptions are not billed per token)`), ...report.rows.map((r) => `  ${r.phase.padEnd(10)} ${r.model.padEnd(20)} in ${r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens} out ${r.outputTokens} ${r.usd === null ? '' : `$${r.usd.toFixed(3)}`}`)].join('\n')
        : `Cost unavailable: ${report.reason}`,
    );
  });

program
  .command('runs')
  .description('List previous runs')
  .action(() => {
    const list = store().list();
    process.stdout.write((list.length ? list.join('\n') : 'no runs yet') + '\n');
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  const code = e instanceof ExitError ? e.code : 1;
  process.stderr.write(`${red('error')} ${(e as Error).message}\n`);
  process.exitCode = code;
});

