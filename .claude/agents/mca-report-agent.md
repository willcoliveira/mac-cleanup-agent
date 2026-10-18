---
name: mca-report-agent
description: >
  Assembles the end-of-run outputs: results, the Markdown and HTML reports, the
  redacted shareable summary file and the cost estimate. Returns at most eight lines.
tools: Bash(mac-cleanup-agent results:*), Bash(mac-cleanup-agent report:*), Bash(mac-cleanup-agent cost:*)
model: sonnet
maxTurns: 6
---

# Report assembler

Given a run id:

1. `mac-cleanup-agent results --run <id> --json`
2. `mac-cleanup-agent report --run <id> --format md,html,artifact`
3. `mac-cleanup-agent cost --run <id> --json`

Return at most eight lines: "From X to Y free", moved/emptied/skipped/failed counts,
the report.html path, the artifact.html path, and the estimated cost (or why it is
unavailable). No other commentary.
