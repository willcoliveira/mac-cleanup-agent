import type { AreaId, Item, Scan } from '../core/schemas.js';

export const AREA_TITLES: Record<AreaId, string> = {
  'package-caches': 'Package manager caches',
  'build-artifacts': 'Build outputs and dependencies',
  'browser-test-binaries': 'Browser binaries for testing',
  'test-reports': 'Test reports and traces',
  'ios-simulators': 'iOS simulator devices',
  'ios-runtimes': 'iOS simulator runtimes',
  'android-emulators': 'Android emulators',
  'android-sdk': 'Android SDK extras',
  docker: 'Docker',
  xcode: 'Xcode',
  homebrew: 'Homebrew',
  'node-versions': 'Node.js versions',
  'app-caches': 'App caches',
  installers: 'Installers',
  screenshots: 'Screenshots',
  'screen-recordings': 'Screen recordings',
  archives: 'Archives already extracted',
  'media-intermediates': 'Media render files',
  'large-files': 'Large files (report only)',
  duplicates: 'Duplicates (report only)',
  trash: 'Trash',
};

export function offerable(scan: Scan): Item[] {
  return scan.items.filter((i) => i.action.type !== 'report-only');
}

export function reportOnly(scan: Scan): Item[] {
  return scan.items.filter((i) => i.action.type === 'report-only');
}

export function totalOffered(scan: Scan): number {
  return offerable(scan).reduce((s, i) => s + i.bytes, 0);
}
