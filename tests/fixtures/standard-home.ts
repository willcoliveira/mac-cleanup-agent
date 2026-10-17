/**
 * The standard synthetic Mac used by scan and e2e tests. It mirrors the kinds
 * of things a real cleanup finds, with generic names only.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Fixture, makeRepo } from '../helpers.js';

export interface StandardHome {
  repo: string;
  trackedRepo: string;
  dirtyRepo: string;
  cameraPhoto: string;
  protectedPhoto: string;
  mailFile: string;
  foreignTrashItem: string;
}

export function buildStandardHome(fx: Fixture): StandardHome {
  // Package caches
  fx.file('Library/Caches/pip/http/a.bin', 3_000_000);
  fx.file('.gradle/caches/modules/b.jar', 4_000_000);
  fx.file('Library/Caches/Google/Chrome/Default/Cache/data_1', 2_500_000);
  // Playwright: two chromium builds, newest kept
  fx.file('Library/Caches/ms-playwright/chromium-1100/chrome', 3_000_000);
  fx.file('Library/Caches/ms-playwright/chromium-1200/chrome', 3_000_000);
  // Android NDK: two versions, newest kept
  fx.file('Library/Android/sdk/ndk/26.1.10909125/source.properties', 2_000_000);
  fx.file('Library/Android/sdk/ndk/27.0.12077973/source.properties', 2_000_000);
  // Projects in Documents
  const repo = makeRepo(fx, 'Documents/projects/demo-app');
  fx.file('Documents/projects/demo-app/node_modules/pkg/index.js', 60_000_000);
  fx.file('Documents/projects/demo-app/playwright-report/index.html', 6_000_000);
  // A repo that tracks its node_modules: must never be offered
  const trackedRepo = makeRepo(fx, 'Documents/projects/demo-vendored');
  fx.file('Documents/projects/demo-vendored/node_modules/pkg/index.js', 60_000_000);
  for (const args of [['add', '-f', 'node_modules'], ['commit', '-q', '-m', 'vendor'], ['push', '-q']]) {
    execFileSync('git', ['-C', trackedRepo, ...args], { stdio: 'ignore' });
  }
  // A dirty repo with a .next build output: clean-pushed policy must skip it
  const dirtyRepo = makeRepo(fx, 'Documents/projects/demo-dirty', { dirty: true });
  fx.file('Documents/projects/demo-dirty/.next/cache/x', 60_000_000);
  // Downloads
  fx.file('Downloads/Demo Installer.dmg', 5_000_000);
  fx.file('Downloads/Screenshot 2026-01-01 at 10.00.00.png', 500_000);
  fx.file("Downloads/Screen Recording 2026-01-02 at 11.00.00.mov", 3_000_000);
  fx.file('Downloads/IMG_1001.PNG', 400_000);
  const cameraPhoto = fx.file('Downloads/IMG_1002.PNG', 400_000);
  fx.p.setMdls(cameraPhoto, { kMDItemAcquisitionModel: 'Sample Phone' });
  fx.file('Downloads/report-bundle.zip', 2_000_000);
  fx.file('Downloads/report-bundle/index.html', 100_000);
  fx.file('Downloads/github-recovery-codes.txt', 0, 'not real\n');
  fx.file('Downloads/client_secret_000.apps.example.json', 0, '{}\n');
  fx.file('Downloads/Invoice_2026-01.pdf', 0, '%PDF-1.4 fake\n');
  fx.file('Downloads/Fatura_Servicos_2026.03.pdf', 0, '%PDF-1.4 fake\n');
  fx.file('Downloads/Passaporte - Sample.pdf', 0, '%PDF-1.4 fake\n');
  // Duplicates (same content twice)
  fx.file('Downloads/movie-copy-a.mov', 12_000_000);
  fx.file('Desktop/movie-copy-b.mov', 12_000_000);
  // A large file (report-only)
  fx.file('Movies/raw-footage.mov', 30_000_000);
  // Protected data
  const protectedPhoto = fx.file('Pictures/Photos Library.photoslibrary/originals/p1.heic', 4_000_000);
  const mailFile = fx.file('Library/Mail/V10/mbox/1.emlx', 3_000_000);
  fx.file('.ssh/id_ed25519', 0, 'fake key\n');
  // Loose permissions on a credential file
  const adb = fx.file('.android/adbkey', 0, 'fake\n');
  chmodSync(adb, 0o644);
  // A symlink pointing into protected data must never be followed
  symlinkSync(join(fx.home, 'Library/Mail'), join(fx.home, 'Downloads/mail-link'));
  // Something the user already put in the Trash themselves
  const foreignTrashItem = join(fx.home, '.Trash', 'Demo Installer.dmg');
  writeFileSync(foreignTrashItem, 'user trashed this');
  return { repo, trackedRepo, dirtyRepo, cameraPhoto, protectedPhoto, mailFile, foreignTrashItem };
}
