# Architecture decisions

*Internal document: repo only, not shipped.*

| ADR | Decision | Status |
|---|---|---|
| 001 | TypeScript CLI + Claude Code plugin sharing one JSON contract | Keep |
| 002 | Ids, not paths (M1) | Keep |
| 003 | Enforcement in the CLI; hooks are a second layer (M2) | Keep |
| 004 | Trash via NSFileManager through JXA (M3) | Keep |
| 005 | Human-only gates for `empty` and `unlock` | Keep |
| 006 | Allocated size, one filesystem | Keep |
| 007 | Tiered sub-agents, judge model chosen per spawn | Keep |
| 008 | Best-effort cost from transcript usage fields | Revisit if Claude Code exposes cost to plugins |
| 009 | Runs stored outside the working directory | Keep |
| 010 | Private forbidden-strings list outside the repo | Keep |

## ADR-001: one CLI, one contract

**Decision.** All disk work lives in a standalone TypeScript CLI; the plugin's skills
call it and read `--json`/`--summary`. Every JSON document carries
`contract_version`; skills abort on a mismatch.
**Alternatives.** Claude running `du`/`find` itself (the manual session this tool came
from). **Evidence.** That session took dozens of tool calls, and nearly emptied a
user's own trashed invoice. **Trade-off.** Two surfaces to version together: the
`bin/` shim pins the npm version to the plugin version.

## ADR-002: ids, not paths

**Decision.** `scan.json` assigns each candidate `i_<12 hex>` bound to
`{realpath, dev, ino, size, mtime, kind}`. Approvals hold ids plus the sha256 of the
exact scan bytes and expire after 24 h. `clean` and `empty` accept no paths. Deep-mode
`propose` takes entry ids from `inspect`. LLM verdicts can only remove items.
**Why.** Neutralises prompt injection through filenames, approvals tampering, and most
TOCTOU races in one place.

## ADR-003: enforcement in the CLI

**Decision.** `src/safety/` is the authority. Hooks (`hooks/scripts/*.mjs`, Node
built-ins only) deny deletes of protected paths, all deletes during a run lock, root,
`osascript` and inline interpreters, and `ask` on every destructive CLI or tool command.
**Why.** The CLI runs without Claude; hooks fail open on any exit code other than 2.
The guard therefore exits 2 on its own errors whenever the raw input contains a
destructive token. **Evidence.** Verified live (2026-10-18, Claude Code 2.1.302): the
guard denied `empty` under `--permission-mode bypassPermissions`, and denied a
protected `rm` issued by a sub-agent.

## ADR-004: NSFileManager through JXA

**Decision.** `osascript -l JavaScript` calling
`trashItemAtURL:resultingItemURL:error:`. **Why.** `/usr/bin/trash` exists only on
macOS 15+, rejects `--`, and does not print where a colliding name was renamed to.
**Evidence.** Out-parameters must be `$()` boxes; `Ref()` crashes osascript (exit 139).
Collisions come back as `name HH-MM-SS-mmm.ext`. `lstat` on a known Trash path works
without Full Disk Access, so `empty` doesn't need it.

## ADR-005: human-only gates

**Decision.** `empty` needs a typed phrase in a TTY, or Claude Code's permission
dialog (the hook returns `ask`). With no backup, a second phrase (TTY) or
`--ack-no-backup` after the user said yes in the conversation. Under
`bypassPermissions` the hook denies `empty` and `unlock` outright. `unlock` works only
in a TTY. **Trade-off.** A determined local script can still pass `--yes`; the tool
protects users from accidents and from the model, not from themselves.

## ADR-006: allocated size, one filesystem

**Decision.** Sizes are `st_blocks × 512` (`du -skx`), never apparent size; simulator
runtimes are measured from `simctl runtime list`, not their mounted volumes.
**Evidence.** A 460 GB sparse `Docker.raw` holding 25 GB; runtime volumes double
counted by `du` on the source Mac.

## ADR-007: tiered agents

**Decision.** haiku indexer (no Read, only `inspect`), sonnet analyst (only `propose`),
judge (only `approvals show|veto`), sonnet reporter. The judge model is chosen per
spawn: `judge_model: auto` tries opus → fable → sonnet, where "failed" means a spawn
error, an empty return, or output that isn't the judge's JSON block (one retry on the
same model first). **Why.** Plugins can't see a user's plan or remaining usage.

## ADR-008: cost estimate

**Decision.** The bash guard records the session's `transcript_path` into the run
folder when it sees `--run`. `cost` streams the transcript and sub-agent transcripts,
reading only `usage` and `model`, grouped by `phase` marks. List prices dated in
`src/cost.ts`. **Revisit** if Claude Code exposes per-session cost to plugins.

## ADR-009: runs outside the working directory

`~/Library/Application Support/mac-cleanup-agent/runs/<scan id>/`, mode 700/600.
Inventories contain real paths and must never land inside a git repository.

## ADR-010: forbidden strings

The real list (client, employer, family and document names from the session that
produced this tool) lives at `~/.config/mac-cleanup-agent/forbidden-strings.txt`, and
the CLI hard-protects that folder. CI uses a placeholder list.
