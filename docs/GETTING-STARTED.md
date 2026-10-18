# Getting started

## 1. Install and check

```bash
npm install -g mac-cleanup-agent
mac-cleanup-agent doctor
```

`doctor` tells you whether your terminal has **Full Disk Access**. If not:

1. System Settings → Privacy & Security → Full Disk Access → turn on your terminal app
   (Terminal, iTerm, VS Code, Warp...). Click **+** if it is not listed.
2. **Quit the app completely** (Cmd+Q) and open it again. A new tab is not enough.
3. Run `mac-cleanup-agent doctor` again.

It also shows whether you have a Time Machine backup. You don't need one to clean,
but emptying the Trash without one asks you to confirm twice.

## 2. Scan

```bash
mac-cleanup-agent scan
```

Read-only. You get areas, sizes and risks:

- **safe**: comes back by itself (caches).
- **review**: comes back, but costs a download or a rebuild (node_modules, simulators).
- **caution**: might be yours (recordings, screenshots). Never pre-approved.

`mac-cleanup-agent report --format html` writes a full report and prints its path.

## 3. Approve

```bash
mac-cleanup-agent approvals init     # prints the path of approvals.yaml
```

The file lists every item with its id. Set areas or items to `true`. Or use
`mac-cleanup-agent approvals set --area package-caches=true --item i_0123456789ab=false`.

## 4. Clean, then empty

```bash
mac-cleanup-agent clean              # dry run
mac-cleanup-agent clean --yes        # move to the Trash
mac-cleanup-agent empty              # type the phrase to confirm
mac-cleanup-agent results
```

Changed your mind before `empty`? Open the Trash in Finder and use **Put Back**.

## 5. Turn Full Disk Access off again

Same place as step 1.

## With Claude Code

```bash
claude plugin marketplace add willcoliveira/mac-cleanup-agent
claude plugin install mac-cleanup-agent@mac-cleanup-agent
```

Then say *"help me free up space"*, or *"deep clean, I'm a video editor"*, or
*"only Docker and old simulators"*. Claude asks before anything moves, and Claude
Code itself asks you to confirm the move to the Trash and the final empty.
