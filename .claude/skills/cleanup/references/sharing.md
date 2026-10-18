# Sharing the result

`mac-cleanup-agent report --run <id> --format artifact` writes `artifact.html` in
the run folder. It contains **only** area names from the catalog and numbers:
no file names, no folder names, no paths. It is built by the CLI from a typed
payload; do not edit it, do not add anything to it.

If the Artifact tool is available and the user wants a shareable page, publish that
file as-is (Read it, then publish its exact contents). Artifacts are private until the
user shares them. If the tool isn't available (API-key login, headless runs), give the
user the local `report.html` path instead.

Never publish `report.html` or `report.md`: those contain real file names.
