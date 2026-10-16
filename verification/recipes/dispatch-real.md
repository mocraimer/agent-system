---
kind: feature
covers: src/adapters, src/commands.ts
ask-first: starts a real agent run on your subscription, under your accounts, recorded in your real state directory
---
# A real dispatch

One approved task dispatched for real, to see a runtime's whole path: admission against live usage,
the vendor run, and what the record says it observed.

## How a user reaches it

- `agentsys dispatch ... --approval <id>` with an approval or grant that covers it.
- The MCP `dispatch` tool, and the control UI's Advanced → Work view.

## Scenarios

### approved-task
Run: `test -n "$VERIFY_DISPATCH_ARGS" || { echo "set VERIFY_DISPATCH_ARGS to the dispatch flags of an approved task"; exit 3; }; npm run --silent build && node dist/cli/main.js dispatch $VERIFY_DISPATCH_ARGS`
Proves: the run's outcome, its admission arithmetic, and its requested, resolved and observed
settings, read from the output and the run's evidence directory.
Check: read

## Gotchas

- It uses the state directory `AGENTSYS_STATE` names (or `.state/` here): set it to the
  installation the approval lives in.
- Claude Code web ends `remote-uncertain` by design; resolve it by reading the session.
