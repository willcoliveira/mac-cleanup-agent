import type { DetectorId } from '../rules/schema.js';
import {
  detectAvds,
  detectDocker,
  detectHomebrew,
  detectNdkOld,
  detectNodeOld,
  detectPlaywrightOld,
  detectRuntimes,
  detectSimulators,
} from './dev.js';
import {
  detectArchivesExtracted,
  detectDuplicates,
  detectInstallers,
  detectLargeFiles,
  detectRecordings,
  detectScreenshots,
} from './files.js';
import type { Detector } from './types.js';

export const DETECTOR_IMPL: Record<DetectorId, Detector> = {
  docker: detectDocker,
  'ios-simulators': detectSimulators,
  'ios-runtimes': detectRuntimes,
  'android-avds': detectAvds,
  'android-ndk-old': detectNdkOld,
  'playwright-old-builds': detectPlaywrightOld,
  'node-versions-old': detectNodeOld,
  homebrew: detectHomebrew,
  installers: detectInstallers,
  screenshots: detectScreenshots,
  'screen-recordings': detectRecordings,
  'archives-extracted': detectArchivesExtracted,
  'large-files': detectLargeFiles,
  duplicates: detectDuplicates,
};
