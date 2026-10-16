---
kind: feature
covers: src/core/authority.ts, src/core/authorize.ts, src/core/floor.ts, scripts/check-fresh-install-refusal.sh
---
# Authority and the floor

The operator approves one task or grants a class of event-triggered work; every dispatch must be
covered by one, and the floor refuses what no authority can permit (merge, force-push, release,
production deploy, a read-only project, a wrong pull request base) before authority is consulted.

## How a user reaches it

- `agentsys approve`, `approvals`, `grant create|list|show|narrow|revoke`, `floor`, all with
  `--as <operator>` where they change authority.
- The control UI's Advanced → Authority view.
- Every `dispatch`, `intake` and loop stage, which ask for authority before running.
- The MCP `dispatch` tool, which cannot create authority or name an operator.

## Scenarios

### unit
Run: `npm run --silent build && node --test dist/core/authority.test.js`
Proves: approvals, grants, narrowing, the floor's bases and read-only projects, and that each
forbidden action is refused even under a grant that lists it.

### fresh-install-refusal
Run: `npm run --silent build && scripts/check-fresh-install-refusal.sh`
Proves: the built CLI, from an empty state directory, holds a dispatch for approval and the refusal
comes from the authority check, not from admission.

## Gotchas

- The fresh-install check supplies a valid estimate on purpose: without it admission refuses too,
  and the check could pass with authority broken.
- Narrowing accepts only a subset; a test that widens through `grant narrow` should expect a refusal.
