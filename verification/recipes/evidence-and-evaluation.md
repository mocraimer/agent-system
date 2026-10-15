---
kind: feature
covers: src/core/evidence.ts, src/core/review.ts, src/core/validate.ts, src/eval
---
# Evidence, scorecards and the replay suite

Acceptance is judged against required checks that name the evidence that can satisfy them;
scorecards keep check results, the agent's claims and the operator's verdict apart; frozen replay
suites compare configurations case by case, and their controls prove the scorer's refusals fire.

## How a user reaches it

- `agentsys checks`, `accept`, `evidence`, `feedback`, `scorecards`, `attest-delivery`.
- `agentsys replay suites|freeze|controls|trials|compare`; `replay run` is the replay-real-run recipe.
- Inspect → Freeze as case in the console; the MCP `evidence` and `evaluation` tools.

## Scenarios

### unit
Run: `npm run --silent build && node --test dist/core/evidence.test.js dist/core/review.test.js dist/core/validate.test.js dist/eval/*.test.js dist/loop/attest.test.js`
Proves: check deferral never reads as a pass, verdict sources stay apart, suites freeze by digest,
and delivery attestation refuses a mismatched run, head or body.

### replay-controls
Run: `npm run --silent build && d=$(mktemp -d) && AGENTSYS_STATE=$d sh -c 'node dist/cli/main.js init --operator verify@example.test && node dist/cli/main.js replay freeze --version v1 && node dist/cli/main.js replay controls --version v1'; s=$?; rm -rf "$d"; exit $s`
Proves: the built-in suite freezes with all four case classes, and each of the six controls makes
the result worse; a control reported BROKEN fails the run.

## Gotchas

- The controls exercise the scorer, not an agent; they say nothing about how a real tier performs.
