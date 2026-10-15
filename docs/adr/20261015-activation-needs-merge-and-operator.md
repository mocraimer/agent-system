# ADR: A build becomes the running system only through a reviewed merge and an explicit operator activation

## Status
Accepted

## Area
Release and configuration

## Decided by
The user

## Context
The coordinator holds the controls that keep agent work bounded. The operator can also change
configuration on their own authority: thresholds, grants, policy. An unmerged build may still need
to be exercised as a test subject.

## Decision
A build becomes the active version only when the operator activates it and names a merged, reviewed
pull request (`agentsys version activate … --merged-pr … --merge-confirmed`). An agent cannot
activate or roll back. Recording a candidate build never touches the active version, and a run keeps
the version it started with. The guide gives the reason for keeping this apart from configuration:
"Changing a threshold or issuing a grant is configuration; it must not double as a way to replace
control code."

## Alternatives Considered
_Not recovered._

## Consequences

### Positive
- Control code changes only through human review plus an explicit act, and never under a run
  already in flight.
- The previous version stays available to roll back to.

### Negative
- Every update needs a human merge and an activation step.

## Enforced by
`src/core/version.test.ts`: "exercising a candidate is not activating it", "activation and rollback"
(refuses an agent, and refuses even the operator without a confirmed merge) and "a run keeps the
version it started with".

## Source
- Retroactive — `docs/OPERATING.md` "Updating the system itself", in the initial public release
  (commit 236c775).
- Session: (no session — captured post-hoc during project setup, 2026-10-15)
- Related: 20261014-consumer-values-live-in-configuration
