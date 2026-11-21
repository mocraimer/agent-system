---
kind: feature
covers: src/loop
ask-first: a real pass writes comments, labels and pull requests on GitHub under your account and starts model runs on your subscriptions
---
# A real loop pass

One real pass over the target store: what the armed service does every interval.

## How a user reaches it

- `agentsys loop --repo <checkout> --once`, or the repository's armed service (`agentsys loop status`
  names it).

## Scenarios

### one-pass
Run: `test -n "$VERIFY_TARGET_REPO" || { echo "set VERIFY_TARGET_REPO to a target checkout"; exit 3; }; npm run --silent build && node dist/cli/main.js loop --repo "$VERIFY_TARGET_REPO" --once`
Proves: the pass's classification and per-stage table, read from the output and `status --repo`.
Check: read

## Gotchas

- Only one loop runs per repository; with its armed service running, this pass is refused with the
  holder's process id. Disarm that repository first (`agentsys loop disarm --repo <checkout>`), or read
  the service's own pass instead. Another repository's armed loop does not matter.
