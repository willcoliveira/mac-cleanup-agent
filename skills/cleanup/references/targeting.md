# Targeting: from the user's words to flags

Default: all profiles (`developer,qa,pm,creator`), all areas. Narrow it when the
user names something. Combine areas with commas. Areas and what they cover:

| User says | Flags |
|---|---|
| caches, npm, pip, gradle, yarn, pnpm, cocoapods | `--area package-caches` |
| node_modules, venv, build folders, .next, Pods | `--area build-artifacts` |
| playwright, cypress, browsers for testing | `--area browser-test-binaries` |
| test reports, traces, test results | `--area test-reports` |
| simulators, iOS simulators | `--area ios-simulators,ios-runtimes` |
| Android emulators, AVD, NDK | `--area android-emulators,android-sdk` |
| Docker | `--area docker` |
| Xcode, DerivedData | `--area xcode` |
| Homebrew, brew | `--area homebrew` |
| old Node versions, nvm | `--area node-versions` |
| Chrome/Slack/Teams cache, app caches | `--area app-caches` |
| Downloads | `--area installers,screenshots,screen-recordings,archives,large-files,duplicates` |
| screenshots, screen recordings | `--area screenshots,screen-recordings` |
| big files, videos, duplicates | `--area large-files,duplicates` (report-only) |
| render files, Final Cut | `--area media-intermediates` |

Profiles, when the user describes themselves rather than areas:
`developer`, `qa` (test engineers), `pm` (business users, Downloads-heavy), `creator`
(video/photo-heavy; strictly report-only for personal media).

When the request is ambiguous ("clean the big stuff"), scan everything and let the
analysis pick the biggest areas; don't ask before scanning.
