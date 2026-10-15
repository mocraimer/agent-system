---
kind: feature
covers: src/loop, examples/ticket-loop
---
# The ticket loop

Over a target repository's GitHub issues, a pass shapes, assesses, sweeps, reviews, fixes and — up
to each ticket's stop-line — merges into `dev`, closes, opens the release pull request and verifies
a deployed release, all under the target's store configuration.

## How a user reaches it

- `agentsys loop --repo <checkout> --once [--dry-run] [--stage ...]`, `loop arm|disarm` (a systemd
  user service), `status --repo`, `evaluation --trust --repo`.
- The target's `tickets/store-config.md` and, optionally, its queue rule modules.
- Labels on pull requests: `apply-comment`, `accept-findings`, `review-again`.

## Scenarios

### unit
Run: `npm run --silent build && node --test dist/loop/*.test.js`
Proves: every stage against a fake store and fake git, the shipped example store configuration
with the built-in queue rules, markers, ranking, operator labels and outside pull requests.

### dry-run-live
Run: `test -n "$VERIFY_TARGET_REPO" || { echo "set VERIFY_TARGET_REPO to a target checkout"; exit 3; }; npm run --silent build && node dist/cli/main.js loop --repo "$VERIFY_TARGET_REPO" --once --dry-run`
Proves: against the real store, each stage's dispatch, skip or blocked decision and its reason,
with nothing written; read the output for decisions that contradict the store configuration.
Check: read

## Gotchas

- A dry run still reads GitHub through your `gh` login and reads authority from the state directory
  `AGENTSYS_STATE` names; with neither set it reads `.state/` here and reports every stage blocked.
- The loop reads the store configuration from the fetched base branch, never the working tree: an
  uncommitted edit there changes nothing. Use `--policy-ref` to try a branch.
