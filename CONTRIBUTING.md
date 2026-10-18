# Contributing

The most useful contribution is a **rule**: a place on macOS that fills up with
regenerable data. Rules are YAML in `rules/`, validated by `src/rules/schema.ts`.

## Adding a rule

```yaml
  - id: dev.example-cache          # profile.name, unique
    profile: developer             # developer | qa | pm | creator | common
    area: package-caches           # one of the catalog areas (src/core/schemas.ts)
    title: Example tool cache
    risk: safe                     # safe | review | caution
    find: { paths: ["~/Library/Caches/com.example.tool"] }
    regenerate: Example tool downloads it again on next start.
    requiresQuit: ["Example Tool"] # process names that must not be running
```

`find` is one of: `paths` (explicit locations), `search` (folders named X under
roots, with a git policy and required siblings), or `detector` (code in
`src/detectors/` for things only a tool can measure).

Checklist:

- [ ] `regenerate` says exactly how the space comes back.
- [ ] `risk` is honest: `safe` only when it comes back with no effort.
- [ ] The path is not personal data. Protected locations are refused anyway.
- [ ] A test in `tests/unit/scan.test.ts` with a fixture under the synthetic HOME.
- [ ] `npm run check` passes.

## Code changes

1. Open an issue first for anything that changes what can be deleted.
2. Conventional Commits (`feat(scan): …`, `fix(clean): …`), one line in CHANGELOG.md.
3. Disk-touching changes need a fake-platform test, plus a test that fails when the
   safety check is removed. CLAUDE.md lists the absolute security rules.
