# ADR: The operator declares which windows a subscription meters; a usage reading never decides it

## Status
Accepted

## Area
Admission

## Decided by
The user

## Context
Admission checks a job against every usage window its subscription meters. Not every plan has both
a five-hour and a weekly window: the operator ruled on 2026-09-09 that the Codex subscription has
only a weekly one. A plan with no five-hour window and a plan whose five-hour figure failed to
arrive send the same thing in a usage reading: nothing.

## Decision
Each subscription declares its windows, and the declaration is the operator's to set
(`agentsys policy --windows`). It is never read off a usage response. Until the operator says
otherwise, both windows apply. A declared window missing from a reading blocks work, as an
unreadable reading does. A window the account reports but the declaration leaves out is checked
anyway and flagged `UNDECLARED`, because a declaration can be a typo or a plan that changed tier.

## Alternatives Considered
- **Infer the windows from what the reading carries**: rejected — a missing window and a window
  that failed to arrive look identical, so guessing would either block a plan that is fine or admit
  work against a limit nobody measured.

## Consequences

### Positive
- Admission never treats an unknown as empty headroom.
- A declaration cannot license spending past a limit the account really enforces.

### Negative
- The operator has to declare each plan's windows; until then, a weekly-only plan is held to both.

## Enforced by
`src/core/admission.test.ts`: "a subscription metered on one window" (including "refuses on a
five-hour window it was not declared to meter but the account reports" and "marks that window
undeclared"), "unusable readings never become headroom" ("blocks when a required window is absent
rather than assuming it is empty") and "a policy stored before windows were declared".

## Source
- Retroactive — `docs/OPERATING.md` "Which windows a subscription meters" (quotes the operator's
  ruling of 2026-09-09), in the initial public release (commit 236c775).
- Session: (no session — captured post-hoc during project setup, 2026-10-15)
