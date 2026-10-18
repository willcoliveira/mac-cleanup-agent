# Known issues

- **ISSUE-001** Cost estimates depend on Claude Code's transcript format, which is not
  a documented API. When it changes, `cost` reports "unavailable" instead of a number.
- **ISSUE-002** Tool-native cleaners (Docker, simulators, npm/uv caches, Homebrew) free
  space immediately and can't be restored from the Trash. Dry runs list them separately.
- **ISSUE-003** Free space is `statfs f_bavail`; macOS "purgeable" space is not counted,
  so Finder may show a slightly larger number.
- **ISSUE-004** `organize` moves with hard links; moving to another disk is refused
  (reported as "destination is on another disk").
- **ISSUE-005** Installer detection matches `.dmg` names to `/Applications` loosely; the
  note "looks installed already" is a hint, not a guarantee.
