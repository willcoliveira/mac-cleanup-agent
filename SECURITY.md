# Security

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** on this repository
(Security → Report a vulnerability). Do not open a public issue. You'll get a reply
within a week. A tool that deletes files takes reports about unsafe deletes,
bypasses of protected paths, and prompt injection seriously, even when they need
unusual conditions.

## What leaves your machine

| Feature | Enabled by | What is sent | To whom |
|---|---|---|---|
| Everything the CLI does | always | **nothing** | nobody |
| Telemetry | never exists | nothing | nobody |
| `npx` fallback in the plugin's `bin/` shim | installing the plugin without a local build | a package download request for the exact pinned version | the npm registry |
| Claude Code plugin | you running it | the compact scan summary, file and folder **labels** of offered items, and command output, as part of your Claude Code conversation | Anthropic, under your Claude Code account and its data settings |
| Shareable summary | you asking Claude to publish `artifact.html` | area names and numbers only (no file names, no paths) | claude.ai Artifacts (private until you share it) |

The plugin never sends file contents. Labels are file and folder names; if names
themselves are sensitive to you, use the CLI without Claude.

## Files the tool reads

- **Metadata only** for everything it scans: names, sizes, dates, inode numbers,
  permissions and selected Spotlight keys (e.g. the camera model, to tell photos from
  screenshots).
- **Contents, only for duplicate detection:** same-size files in Downloads and Desktop
  are hashed (sha256) to confirm they are byte-identical. Files with secret-looking
  names and protected locations are never hashed.
- **Your Claude Code transcript, usage fields only,** for `cost`: model names and
  token counts. Conversation text is not parsed into memory or stored.

## Files the tool changes

- Moves approved items to the Trash with `NSFileManager` (recoverable).
- Runs a tool's own cleaner when that is the safe way (`npm cache clean`, `uv cache
  clean`, `brew cleanup`, `docker image prune -a`, `docker builder prune -a`,
  `xcrun simctl delete <device>`, `xcrun simctl runtime delete <id>`). Never
  `docker system prune --volumes`.
- `empty` deletes only Trash entries this run created and that still match.
- `organize` moves documents (hard link, then unlink: never overwrites).
- `security --fix` only tightens permissions on a regular file you own.
- Writes its own state under `~/Library/Application Support/mac-cleanup-agent/` (mode 600/700).

## Full Disk Access

The scan needs it to see Downloads, Desktop and the Trash. While it is on, every
program started from that terminal app can read your whole disk. Grant it for the
cleanup, then turn it off again (System Settings → Privacy & Security → Full Disk
Access). `doctor` and the plugin remind you.

## If something was deleted by mistake

Until `empty` runs, everything is in the Trash: open it in Finder and use **Put
Back**. `mac-cleanup-agent audit --run <id>` shows where every item of a run is.
Tool-native cleaners (Docker images, simulators, package caches) are not
recoverable this way, which is why they are listed separately in every dry run.
