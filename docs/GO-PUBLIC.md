# Go-public checklist

*Internal document: repo only, not shipped.* Run before the first push.

- [ ] `npm run check` green (build, types, tests, plugin mirror, pack contents)
- [ ] `node scripts/check-forbidden.mjs --history` clean with the **private** list
- [ ] `gitleaks git --config .gitleaks.toml .` and `gitleaks dir .` clean
- [ ] `claude plugin validate . --strict` and `claude plugin validate .claude-plugin/plugin.json --strict`
- [ ] Dogfood: read-only `mac-cleanup-agent scan` on the maintainer's Mac matches the
      areas found in the manual cleanup; output reviewed, never committed
- [ ] `cd site && npm run build` green
- [ ] Versions in sync (package.json, plugin.json, marketplace.json)
- [ ] GitHub: create public repo, enable private vulnerability reporting, Pages from
      Actions, npm trusted publishing for `release.yml`
- [ ] Push `main`, then tag `v1.0.0` (npm publish must succeed before announcing the
      plugin: the shim pins `mac-cleanup-agent@1.0.0`)
