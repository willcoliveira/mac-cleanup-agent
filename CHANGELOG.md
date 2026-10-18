# Changelog

## [1.0.0] - 2026-10-18

First release.

### Added

- CLI: `doctor`, `scan`, `report`, `approvals`, `clean`, `empty`, `results`, `audit`,
  `organize`, `security`, `inspect`, `propose`, `unlock`, `rules`, `cost`, `runs`.
- 39 built-in rules for developers, QA engineers, PMs and creators, plus user rules and
  overrides in `~/.config/mac-cleanup-agent/rules.yaml`.
- Trash-first cleanup through NSFileManager with per-item identity checks, and an
  `empty` that deletes only the run's own Trash entries.
- Reports: terminal, Markdown, self-contained HTML, JSON summary, and a redacted
  shareable artifact.
- Claude Code plugin: `/mac-cleanup-agent:cleanup` (quick and deep modes), `:scan`,
  `:organize`, `:security`; four tiered sub-agents; PreToolUse guards.
- Docs site on GitHub Pages.

### Security

- Protected data, root refusal, Full Disk Access gate, approvals pinned to the scan
  hash, human-only gates for `empty` and `unlock`, hook guards verified under
  `bypassPermissions` and inside sub-agents.
