---
kind: eval
covers: src/eval/replay-run.ts, src/loop/prompts
ask-first: replays frozen cases through real model runs on your subscriptions
---
# Replaying frozen cases on a real tier

A frozen incident suite run for real on one configuration, so two configurations can be compared on
the cases the operator froze.

## How a user reaches it

- `agentsys replay run --version <suite> --repo <checkout> --configuration stage:runtime/model/effort:digest`,
  then `replay compare`.
- The improve stage replays cases itself before it proposes a change.

## Scenarios

### one-configuration
Run: `test -n "$VERIFY_REPLAY_ARGS" || { echo "set VERIFY_REPLAY_ARGS to the replay run flags"; exit 3; }; npm run --silent build && node dist/cli/main.js replay run $VERIFY_REPLAY_ARGS`
Proves: each case's outcome on that configuration; read it beside `replay compare`.
Check: read

## Gotchas

- Only the review stage is replayable today, and the run needs a grant or approval for work class
  `replay-review`.
- A trial is evidence only about the prompt digest it names.
