# ADR: A local, GitHub-backed console, and an improve stage that only proposes

## Status
Accepted

## Area
Operator console

## Decided by
The user

## Context
The loop's state already lives on GitHub: labels, comments, hidden markers and merges. The operator
needed a console to see that state and act on it, and the loop needed a way to get better at its
own stages from the scorecards it keeps. Every console action is a write under the operator's own
identity, and the improve stage's evidence is small samples scored partly from derived verdicts,
which are signal rather than the operator's word.

## Decision
The console is the coordinator's existing loopback UI. It reads the ticket store from GitHub
through the operator's own `gh` login on every refresh and keeps nothing but the last snapshot,
because GitHub already is the store; a second copy would be one more thing to drift from it and one
more place holding the operator's credentials. It is offered only on the operator's own machine,
behind a one-time bootstrap token.

The improve stage only proposes: one branch and one pull request per knob, in the repository that
owns the change. Applying its own changes would let the loop raise its own trust on numbers nobody
granted.

## Alternatives Considered
- **A hosted or remotely reachable console**: set aside for the drift and credential reasons above,
  and for exposure — every action is a write under the operator's identity.
- **Apply a change automatically when its trial improved**: rejected — a trial of a handful of
  frozen cases does not justify changing what every future run does.
- **Tune continuously in-process, without a pull request**: rejected — the store configuration is
  the one place policy lives, and it changes only by a merged pull request.

## Consequences

### Positive
- No second store to keep in step with GitHub, and no service holding the operator's credentials.
- Every policy change the loop suggests passes through a person's review.

### Negative
- The console works only on the machine that runs the coordinator.
- Improvements wait for a person to merge them.

## Source
- Retroactive — recorded first as a short decision note on 2026-09-18, moved into this format when
  the project adopted ADRs.
