# Delegation: who does what, and what it costs

| Tier | Who | Model | Does |
|---|---|---|---|
| 0 | `mac-cleanup-agent` CLI | none (zero tokens) | sizes, rules, protection, identity checks, every change, reports, cost |
| 1 | `mca-area-indexer-agent` | haiku, effort low | deep mode: `inspect` folders, return compact JSON |
| 1 | `mca-area-analyst-agent` | sonnet | deep mode: classify inspected entries, `propose` reclaimable ones with a reason |
| 1 | `mca-report-agent` | sonnet | assemble the final report files, ≤ 8-line summary back |
| 2 | `mca-risk-judge-agent` | top available (below) | review the approved delete list; veto anything risky |
| 2 | you (session model) | | explain, interview, decide what to ask, talk to the user |

**Never delegate:** the approval interview, anything you tell the user about what
will be deleted, the decision to run `clean --yes` or `empty`.

## Judge model

`doctor --json` returns `judgeModel` from the user's
`~/.config/mac-cleanup-agent/rules.yaml` (`judge_model: auto|opus|fable|sonnet`).

- `opus`, `fable`, `sonnet`: spawn the judge with that model.
- `auto` (default): try `opus` (effort high). If the spawn errors, returns nothing,
  or returns output that is not the judge's JSON block, retry once on the same
  model, then fall back to `fable`, then `sonnet`. A user on usage limits should set
  `judge_model: fable`.

Pass the model when you spawn the agent. Tell the user which model judged and, if a
fallback happened, why. Give the judge only the run id: it reads the approved list
itself with `approvals show --json`.

## Read budget

Read only `--summary` and `--json` outputs. Never read scan.json, manifest.jsonl or
transcripts. Deep mode: at most 6 `inspect` calls per run unless the user asks for more.
