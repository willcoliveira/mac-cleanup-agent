/**
 * Preflight checks shared by `doctor`, `scan`, `clean` and `empty`.
 */
import { join } from 'node:path';
import type { Environment } from '../core/schemas.js';
import type { Platform } from '../platform/types.js';

/** Process names whose apps must be quit before their caches are cleaned. */
export const WATCHED_APPS = [
  'Google Chrome',
  'Slack',
  'MSTeams',
  'Xcode',
  'Simulator',
  'qemu-system-aarch64',
  'qemu-system-x86_64',
  'Final Cut Pro',
  'Docker Desktop',
  'Code',
];

/**
 * Full Disk Access can't be queried directly. Listing the user's Trash is
 * denied without it on every supported macOS version, so that is the probe.
 * The TCC folder is a second probe on a real Mac (it doesn't exist in tests).
 */
export async function hasFullDiskAccess(p: Platform): Promise<boolean> {
  for (const probe of [p.trashRoot, '/Library/Application Support/com.apple.TCC']) {
    if ((await p.readdir(probe)) === 'denied') return false;
  }
  return true;
}

export async function backupStatus(p: Platform): Promise<Environment['backup']> {
  const dest = await p.exec('/usr/bin/tmutil', ['destinationinfo']);
  const configured = dest.code === 0 && !/No destinations configured/i.test(dest.stdout + dest.stderr) && dest.stdout.trim() !== '';
  if (!configured) return { configured: false, latest: null };
  const latest = await p.exec('/usr/bin/tmutil', ['latestbackup']);
  return { configured: true, latest: latest.code === 0 && latest.stdout.trim() ? latest.stdout.trim() : null };
}

/**
 * iCloud Desktop & Documents sync. When it is on, moving those files to the
 * Trash propagates to iCloud and the user's other devices. Reads the live
 * Finder setting, not the presence of CloudDocs folders (those linger after
 * sync is turned off).
 */
export async function icloudDesktopDocuments(p: Platform): Promise<Environment['icloudDesktopDocuments']> {
  const values: string[] = [];
  for (const key of ['FXICloudDriveDesktop', 'FXICloudDriveDocuments']) {
    const r = await p.exec('/usr/bin/defaults', ['read', 'com.apple.finder', key]);
    if (r.code === 0) values.push(r.stdout.trim());
  }
  if (values.length === 0) return 'unknown';
  return values.some((v) => v === '1' || v.toLowerCase() === 'true') ? 'on' : 'off';
}

export async function runningApps(p: Platform): Promise<string[]> {
  const out: string[] = [];
  for (const name of WATCHED_APPS) {
    const r = await p.exec('/usr/bin/pgrep', ['-x', name]);
    if (r.code === 0 && r.stdout.trim()) out.push(name);
  }
  return out;
}

export async function macosVersion(p: Platform): Promise<string> {
  const r = await p.exec('/usr/bin/sw_vers', ['-productVersion']);
  return r.code === 0 ? r.stdout.trim() : 'unknown';
}

export async function detectEnvironment(p: Platform): Promise<Environment> {
  return {
    macos: await macosVersion(p),
    arch: process.arch,
    fullDiskAccess: await hasFullDiskAccess(p),
    backup: await backupStatus(p),
    icloudDesktopDocuments: await icloudDesktopDocuments(p),
    runningApps: await runningApps(p),
  };
}

/** Refuses root: a cleanup tool running as root could reach other users' data. */
export function refuseRoot(p: Platform): string | null {
  if (p.uid === 0 || p.env.SUDO_USER) {
    return 'mac-cleanup-agent never runs as root or under sudo. Run it as your normal user.';
  }
  return null;
}

export function fdaGuidance(terminalHint?: string): string {
  const app = terminalHint ?? 'your terminal app (Terminal, iTerm, VS Code, Warp...)';
  return [
    'Full Disk Access is required: without it macOS hides Downloads, Desktop, the Trash, Mail and more,',
    'so a scan would miss a large part of your disk (100 GB on the Mac this tool was built on).',
    '',
    `  1. System Settings → Privacy & Security → Full Disk Access → turn on ${app}.`,
    '     If it is not listed, click + and add it from /Applications.',
    '  2. Quit that app completely (Cmd+Q) and open it again. Restarting the shell is not enough.',
    '  3. Run the scan again.',
    '',
    'When you are done cleaning, turn Full Disk Access off again in the same place.',
  ].join('\n');
}

export function terminalFromEnv(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const t = env.TERM_PROGRAM;
  if (!t) return undefined;
  return { 'iTerm.app': 'iTerm', Apple_Terminal: 'Terminal', vscode: 'Visual Studio Code', WarpTerminal: 'Warp', ghostty: 'Ghostty' }[t] ?? t;
}

export function freeSpacePath(p: Platform): string {
  return p.home;
}

export const DATA_VOLUME = join('/', 'System', 'Volumes', 'Data');
