# ADR: Merge, auto-merge, force-push, release and production deploy are refused before authority is consulted

## Status
Accepted

## Area
Authority

## Decided by
The user

## Context
Every dispatch must be covered by authority: an operator approval for one task, or a standing grant
for a class of work. A grant can be written too broadly, by mistake or on purpose, and the agents
this system starts act under the operator's own accounts.

## Decision
A fixed set of actions — merge, auto-merge, force-push, release and production deploy — is refused
before authority is consulted, so no approval or grant can reach them, however broad. The one merge
the system makes, `merge-dev` into `dev` by the loop's merge stage, is a separate action that needs
a grant naming it.

The guide gives the reason: refusing these before authority means "a grant written too broadly
still cannot reach them". The comment on `authorizeDispatch` in `src/core/authorize.ts` gives a
second: such a request is refused outright rather than reported as merely unapproved, "which would
invite an operator to 'fix' it by approving harder". CONTRIBUTING states that a change weakening this will not be accepted.

## Alternatives Considered
_Not recovered._

## Consequences

### Positive
- A mistaken or over-broad grant cannot merge into `main`, rewrite history, release or deploy.

### Negative
- An operator who wants one of these actions does it by hand, outside the system.

## Enforced by
`FORBIDDEN_ACTIONS` in `src/core/authorize.ts`, held by `src/core/authority.test.ts` "the floor no
authority can relax" (refuses each action even under a grant that lists it), by
`src/cli/cli.integration.test.ts` "refuses to even record a grant that names a forbidden action" and
"refuses a dispatch naming a forbidden action", and by `scripts/check-fresh-install-refusal.sh`,
which CI runs on every pull request.

## Source
- Retroactive — the decision is in the initial public release (commit 236c775): `README.md`,
  `docs/OPERATING.md` "What it does not do", `CONTRIBUTING.md` "Safety rules the code keeps",
  `SECURITY.md`. Earlier history is not public.
- Session: (no session — captured post-hoc during project setup, 2026-10-15)
