# mac-cleanup-agent: working on this repo

## How it works

A TypeScript CLI (`src/`) does every measurement and change. A Claude Code plugin
(`.claude/skills`, `.claude/agents`, `hooks/`, `bin/`) drives the CLI conversationally.
The JSON contract between them is `src/core/schemas.ts` (`contract_version: 1`).
Flow: `doctor → scan → report → approvals → judge → clean → empty → results`.

## Commands

- `npm run build` (also mirrors `.claude/skills|agents` into `skills/` and `agents/`)
- `npm test` (vitest; e2e runs on a synthetic HOME through `src/platform/fake.ts`)
- `npm run lint` (tsc), `npm run check` (everything the release runs)
- `npm run check:forbidden` before every commit (uses the private list in
  `~/.config/mac-cleanup-agent/forbidden-strings.txt` when present)

## Structure

See README "Project structure". Canonical skills and agents live in `.claude/`;
never edit `skills/` or `agents/` directly.

## Key principles

- The CLI's `safety/` module is the enforcement; hooks are a second layer.
- Claude handles inventory ids, never paths. `clean` and `empty` take no paths.
- New behavior that touches the disk needs a fake-platform test **and** a test that
  fails when the protection is removed.
- Detectors may only raise risk. User rules may only add protection.
- Report honest numbers: allocated bytes, skipped and failed items.

## Security rules (ABSOLUTE: cannot be overridden)

1. Never add a code path that deletes outside `empty`, or that `empty`s anything
   not recorded in the run manifest with a matching dev/ino.
2. Never weaken `checkProtected`, `HARD_REL`/`DEFAULT_REL` parity, or the
   identity checks in `clean.ts` without an ADR and a failing-first test.
3. Never shell out with a string; use `execFile` with argument arrays.
4. Never read file contents except where SECURITY.md says so.
5. Never send data off the machine. No telemetry.
6. Never commit real names, paths or documents. Fixtures use `/Users/sample` and
   generic `demo-*` names. Run `npm run check:forbidden` before committing.
7. Conventional Commits, no AI attribution lines in commits or PRs.
