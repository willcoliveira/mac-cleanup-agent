# Output contract (contract_version: 1)

Every JSON document from the CLI carries `contract_version`. This plugin speaks
**1**. On any other value, stop and tell the user to update the plugin and CLI
together (`claude plugin update mac-cleanup-agent` and `npm i -g mac-cleanup-agent`).

- `doctor --json`: `fullDiskAccess`, `backup{configured,latest}`,
  `icloudDesktopDocuments`, `runningApps[]`, `rootRefused`, `freeBytes`, `judgeModel`.
- `scan --summary`: `scan_id`, `free`, `offered_total`, `environment`,
  `areas[{area,title,size,items,maxRisk,top[{id,title,label,size,risk,action,regenerate,notes,requiresQuit,aiClassified}],more}]`,
  `reportOnly[]`, `protected[]`, `trash`, `security[]`, `duplicates`, `warnings[]`,
  `untrusted_fields`.
- `approvals show --json`: `items[{id,area,risk,bytes,title,aiClassified}]`.
- `clean --json`: dry run `{dryRun,items,blocked,bytes}`; with `--yes` the results.
- `results --json` / `empty --json`: `before`, `after` (`availableBytes`),
  `trashedBytes`, `trashedItems`, `emptiedBytes`, `skipped`, `failed`.
- `inspect`: `{untrusted:true, root, bytes, entries[{entry,name,kind,bytes,modified}], extensions[]}`.
- `cost --json`: `{available, reason?, pricingDate, rows[], totalUsd}`.

Sizes are decimal (1 GB = 10^9 bytes). Free space is statfs `f_bavail`
(purgeable space not included).
