# mac-cleanup-agent

**Free up disk space on your Mac safely.** A command-line tool and Claude Code plugin that scans your Mac, explains what is taking space, asks you what to remove, moves it to the Trash and shows the result: **from 145 GB to 267 GB free**.

Built for people whose disks fill up for a living: **developers** (node_modules, Docker, Xcode, simulators, package caches), **QA engineers** (Playwright browsers, test reports, emulators, screen recordings), **PMs and business users** (Downloads full of installers, zips and screenshots) and **creators** (render files, duplicates, huge videos). It never touches your photos, mail, messages, keys or documents.

| What it does | How |
|---|---|
| Finds reclaimable space | 39 built-in rules across 20 areas, from npm caches to old iOS runtimes, measured by allocated size (a 460 GB sparse Docker disk that holds 25 GB counts as 25 GB) |
| Explains it | Per area: size, risk, and how it comes back ("npm downloads packages again on the next install") |
| Asks before anything moves | Claude interviews you area by area, or you edit `approvals.yaml` |
| Moves to the Trash first | Nothing is deleted until a separate, human-confirmed `empty`, which removes only this run's items |
| Proves the result | Before and after free space, a self-contained HTML report, and a shareable summary with no file names |
| Stays safe | Protected data, identity checks right before every move, hook guards in Claude Code, no root, no telemetry |

## Requirements

- macOS 14 or later (Apple Silicon or Intel)
- Node.js 22 or later
- **Full Disk Access** for your terminal app. Without it macOS hides Downloads, Desktop, the Trash and more, so a scan would miss a big part of your disk. `mac-cleanup-agent doctor` walks you through it, and reminds you to turn it off again when you're done.
- Optional: [Claude Code](https://code.claude.com) for the guided, conversational cleanup

## Install

**1. npm (CLI)**

```bash
npm install -g mac-cleanup-agent
mac-cleanup-agent doctor
```

**2. Claude Code plugin** (the guided cleanup)

```bash
claude plugin marketplace add willcoliveira/mac-cleanup-agent
claude plugin install mac-cleanup-agent@mac-cleanup-agent
```

Then, in Claude Code: `/mac-cleanup-agent:cleanup` or just *"my disk is full, help me clean up"*.

**3. From source**

```bash
git clone https://github.com/willcoliveira/mac-cleanup-agent && cd mac-cleanup-agent
npm ci && npm run build && npm link
```

## Quick start

```bash
mac-cleanup-agent scan                      # read-only; prints areas, sizes, risks
mac-cleanup-agent report --format html      # self-contained report in the run folder
mac-cleanup-agent approvals init            # writes approvals.yaml, everything off
#   edit approvals.yaml: set the areas or items you want to true
mac-cleanup-agent clean                     # dry run: shows exactly what would move
mac-cleanup-agent clean --yes               # moves approved items to the Trash
mac-cleanup-agent empty                     # type "EMPTY <n>" to delete only this run's items
mac-cleanup-agent results                   # From X GB to Y GB free
```

Targeted cleanups work the same way: `mac-cleanup-agent scan --area docker,ios-simulators,ios-runtimes`, or tell Claude *"just Docker and the old simulators"*.

## How it works

```
doctor ──► scan ──► report ──► approvals ──► judge ──► clean ──► empty ──► results
  FDA,      rules,    md/html/    Claude         risk      Trash      only this     from X
  backup,   sizes,    json/       interview or   judge     first,     run's items,  to Y
  iCloud    ids       artifact    approvals.yaml vetoes    verified   human-gated   GB free
```

Every item gets an opaque inventory id bound to its filesystem identity (device, inode, size, realpath). Approvals refer to ids and are pinned to the scan's sha256. `clean` and `empty` take no paths at all. Right before each move the item is checked again: same inode, no symlink swapped in, still not protected. Anything that changed is skipped and reported.

The Trash is driven through macOS `NSFileManager`, which reports where each item landed, including the renamed path after a name collision. `empty` deletes exactly those entries and only if they still match. Things you put in the Trash yourself are never touched.

## CLI

| Command | What it does |
|---|---|
| `doctor` | Full Disk Access, backup, iCloud Desktop & Documents sync, running apps, free space |
| `scan [--profile] [--area] [--summary\|--json]` | Read-only scan; writes the run inventory |
| `report [--run] [--format terminal,md,html,json,artifact]` | Reports for a run |
| `approvals init\|set\|show\|veto` | Create and change approvals (by area or item id) |
| `clean [--run] [--yes]` | Dry run, then move approved items to the Trash |
| `empty [--run]` | Permanently delete only this run's Trash entries (typed confirmation; extra one without a backup) |
| `results`, `audit`, `runs` | Before/after numbers, a read-only re-check, past runs |
| `organize [--dir] [--dest] [--apply <plan>]` | Sort loose documents into category folders (dry run first) |
| `security [--fix <id> --yes]` | Secrets left lying around and credential files others can read |
| `inspect <folder>`, `propose` | Deep mode: look inside unknown big folders, propose items (AI-classified, per-item approval) |
| `unlock <exact path>` | Let one protected path be scanned once (typed by you in a terminal, twice) |
| `rules list\|validate` | The effective rule catalog |
| `cost [--run]` | Estimated token cost of a plugin run, per phase |

Exit codes: `0` ok, `1` error, `2` bad usage, `3` Full Disk Access missing, `4` a human confirmation was not given.

## The Claude Code plugin

`/mac-cleanup-agent:cleanup` runs the whole flow as a conversation. Claude reads only a compact, size-capped summary and talks about items by id, never by path. The CLI does every measurement and change.

| Mode | What Claude does | Cost |
|---|---|---|
| **Quick** (default) | Explains the scan, interviews you, has the judge review, cleans | Low: one summary read, a short interview |
| **Deep** (*"deep clean"*) | Also investigates large folders no rule covers, with cheap sub-agents | Higher; shown per phase in the report |

| Sub-agent | Model | Job |
|---|---|---|
| `mca-area-indexer-agent` | haiku, low effort | Deep mode: `inspect` folders (names, sizes, dates; never contents) |
| `mca-area-analyst-agent` | sonnet | Deep mode: propose clearly regenerable entries, with a reason |
| `mca-risk-judge-agent` | top available: opus (high), else fable, else sonnet | Reviews the approved list and can only **veto** |
| `mca-report-agent` | sonnet | Results, reports, cost; returns 8 lines |

Set the judge model in `~/.config/mac-cleanup-agent/rules.yaml` with `judge_model: auto | opus | fable | sonnet`. Use `fable` if you are close to usage limits.

Other skills: `/mac-cleanup-agent:scan` (read-only report), `/mac-cleanup-agent:organize`, `/mac-cleanup-agent:security`.

**Hook guards** (PreToolUse, fail-closed on destructive commands): deletes of protected data are denied however they are spelled (`rm`, `find -delete`, `bash -c`, `$(…)`, `xargs`); every delete is denied while a cleanup run holds its lock; `sudo`, `osascript` and inline interpreters are denied; `clean --yes`, `empty`, `docker … prune` and `simctl delete` always ask you; `empty` and `unlock` are denied outright when permissions are bypassed. Tested live under `bypassPermissions` and inside sub-agents.

## Profiles and rules

| Profile | Areas |
|---|---|
| `developer` | package caches (npm, uv, pip, Poetry, pnpm, Yarn, Gradle, CocoaPods, Go), node_modules and virtualenvs (gitignored only), build outputs (clean, pushed repos only), Xcode, iOS simulators and runtimes, Android emulators and old NDKs, old Node versions, Homebrew, Docker images and build cache |
| `qa` | old Playwright browser builds, Cypress cache, test reports and traces, screenshots and screen recordings |
| `pm` | installers in Downloads, zips already extracted, Chrome / Slack / Teams / VS Code caches |
| `creator` | large files and byte-identical duplicates (report only), Final Cut render files |

Add your own rules or switch built-in ones off in `~/.config/mac-cleanup-agent/rules.yaml`:

```yaml
disable: [qa.screenshots]
minBytes: { dev.node-modules: 200000000 }
protect: ["~/Projects/keep-this"]
rules:
  - id: user.render-cache
    profile: creator
    area: media-intermediates
    title: My render cache
    risk: review
    find: { paths: ["~/Renders/cache"] }
    regenerate: The editor re-renders it on open.
```

User rules can add protection and candidates; they can never remove a protection, and are always at least `review` risk. Patterns are names and `*`/`?` globs, never regular expressions.

## What is protected

Never offered, under any flag: Keychains, `~/.ssh`, `~/.gnupg`, the Trash itself, this tool's state. Protected by default (unlockable one exact path at a time, typed in a terminal): the Photos library, Mail, Messages, iCloud Drive, cloud storage folders, Contacts, Calendars, browser profiles, iPhone backups, your Documents/Desktop/Pictures/Music/Movies folders themselves, credential files and downloaded ML models. Camera photos are never classified as screenshots. Docker volumes are listed, never removed in bulk. Simulator runtimes are deleted after their devices, never before.

## Reports and sharing

Each run lives in `~/Library/Application Support/mac-cleanup-agent/runs/<scan id>/`, never in your working directory: `scan.json`, `approvals.yaml`, an append-only `manifest.jsonl`, `results.json`, `report.md`, `report.html` (self-contained, no scripts, no network) and `artifact.html`. The artifact is built from area names and numbers only, so it can be shared as a claude.ai Artifact without exposing a single file name.

## Security and privacy

Nothing leaves your Mac. No telemetry, ever. See [SECURITY.md](SECURITY.md) for the full "what leaves your machine" table, and [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for how the tool defends against prompt injection through filenames, symlink swaps, tampered approvals and accidental deletes.

## Project structure

```
src/
  cli/          commander CLI (every command, exit codes)
  core/         zod contract (contract_version 1), ids, formatting
  platform/     Platform interface: real macOS + a fake for tests
  rules/        rule schema, loader, user overrides
  detectors/    folder search with git policy, Docker, simulators, Android, files
  safety/       protected paths, unlock, environment checks
  scan.ts clean.ts empty.ts inspect.ts organize.ts security.ts cost.ts runs.ts
  report/       terminal, markdown, html, summary, redacted artifact
rules/          built-in rule catalog (YAML) and organize rules
.claude/        canonical skills and agents (mirrored to skills/ and agents/)
hooks/          PreToolUse guards (Node built-ins only)
bin/            launcher shim for plugin installs
site/           Astro docs site (GitHub Pages)
tests/          unit, plugin lints, hook guards, e2e on a synthetic HOME
```

## Tech stack

| | |
|---|---|
| Runtime | Node.js 22+, TypeScript (strict), ESM |
| CLI | commander, zod, yaml (three runtime dependencies) |
| Trash | NSFileManager via JXA (works on every supported macOS) |
| Tests | vitest; a fake platform over a synthetic HOME |
| Plugin | Claude Code skills, sub-agents, PreToolUse hooks |
| Site | Astro on GitHub Pages |

## Key principles

- **Trash first.** Everything is recoverable until you empty, and empty removes only what this run moved.
- **Ids, not paths.** Approvals are bound to inventory ids and the scan hash. Nothing can be slipped in later.
- **Honest numbers.** Allocated size, not apparent size. Skipped and failed items are always reported.
- **The tool measures; the model explains.** Claude never runs `rm`. It never needs to.
- **Protective by default.** When in doubt, report it and leave it.

## Documentation

- [Getting started](docs/GETTING-STARTED.md)
- [Architecture decisions](docs/ARCHITECTURE-DECISIONS.md)
- [Threat model](docs/THREAT-MODEL.md)
- [Contributing rules](CONTRIBUTING.md)
- Website: <https://willcoliveira.github.io/mac-cleanup-agent/>

## License

MIT © William Oliveira. If this saved you a few hundred gigabytes, consider [sponsoring](https://github.com/sponsors/willcoliveira).
