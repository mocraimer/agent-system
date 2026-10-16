---
kind: feature
covers: src/console, src/ui, ui-tests
---
# The operator console

A loopback-only board over the loop's store: every open ticket and pull request in one column
(Needs you, Working, In review, Ready to merge), the evidence behind it, an inbox of actions, steering
of stop-lines and tiers by pull request, and Inspect with Freeze as case.

## How a user reaches it

- `agentsys ui --repo <checkout>`: prints a one-time URL on `127.0.0.1`. `--store-file <json>`
  reads a fixture store instead of GitHub.
- `agentsys console --repo <checkout> --print`: the same board, read-only, in a terminal.
- Views: Board, Inbox, Activity, Steer, Inspect.

## Scenarios

### unit
Run: `npm run --silent build && node --test dist/console/*.test.js dist/ui/server.test.js`
Proves: the column facts, derived verdicts, inbox actions, steering proposals, freezing a case, the
last-snapshot cache, and the server's loopback bind, one-time token and session rules.

### board
Run: `npm run --silent build && npx playwright test ui-tests/console.spec.ts`
Proves: the real `agentsys ui --store-file` renders the board beside evidence with counts matching
the fact model, "Nothing to do" on an empty store, the stale last snapshot, and a used bootstrap link.

### inbox-journey
Run: `npm run --silent build && npx playwright test ui-tests/console-journey.spec.ts`
Proves: every inbox action, pausing and resuming a stage, and stopping and redispatching a run,
through the command layer with a fake adapter.

### decision-workspace
Run: `npm run --silent build && npx playwright test ui-tests/decision-workspace.spec.ts`
Proves: the layout at 1440, 768, 390 and 320 px, keyboard use, reduced motion, response races and
the decision panels.

### print-live
Run: `test -n "$VERIFY_TARGET_REPO" || { echo "set VERIFY_TARGET_REPO to a target checkout"; exit 3; }; npm run --silent build && node dist/cli/main.js console --repo "$VERIFY_TARGET_REPO" --print`
Proves: the board read from the real store through `gh`; read it for items in the wrong column.
Check: read

## Gotchas

- `console.spec.ts` writes screenshots to `test-results/console-screens/`; the ones in
  `docs/console-screens/` are copied from there by hand (docs/CONTROL-UI.md has the command).
- The browser specs import from `dist/`; run them after a build, never against a stale one.
