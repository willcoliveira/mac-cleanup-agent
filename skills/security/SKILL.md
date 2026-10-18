---
name: security
description: >
  Find secrets left lying around (2FA recovery codes, OAuth client secrets,
  certificates and keys in Downloads/Desktop/Documents) and credential files other
  users can read (~/.ssh keys, ~/.npmrc, adbkey). Never reads the files; only offers
  permission tightening. Use when user says: "check for exposed secrets",
  "security check my mac", "are my keys safe".
allowed-tools: Bash(mac-cleanup-agent security:*), Bash(mac-cleanup-agent doctor:*)
---

# Security findings

1. `mac-cleanup-agent doctor --json`; stop if Full Disk Access is missing.
2. `mac-cleanup-agent security --json`. Never open, read, copy or move any listed file.
3. For `secret-filename` and `key-file` findings: advise moving the secret into a
   password manager or Keychain, then deleting the loose copy themselves.
4. For `loose-permissions` findings with a fix: ask the user; on a yes run
   `mac-cleanup-agent security --fix <findingId> --yes` (Claude Code asks them to
   confirm). It only tightens permissions on a regular file they own.
