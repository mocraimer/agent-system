# ADR: Why a pull request is blocked or stopped is told in one comment the loop edits in place

## Status
Accepted

## Area
Ticket loop

## Decided by
The user

## Context
The loop writes a status label on each pull request (`loop:working`, `loop:blocked`, `loop:stopped`,
`loop:skipped`). A label says where a pull request is, not why. The reason lived only in the
operator's pass log, so a person who opened a blocked pull request could not tell what held it or
whether anything was needed from them. The loop posts comments under the operator's own login, and
a pass runs every fifteen minutes, so a comment per label change would fill the timeline of a pull
request that flips between states. The pull request description is no place for it: editing the
description starts a new review and makes the fix and merge stages skip ("the review does not cover
the current PR description").

## Decision
When a pull request first needs a person or is refused, the loop writes one status comment on it and
afterwards edits that comment in place. It is edited when the label, the stage or the kind of reason
changes, never when only a number in the reason moved, and it never mentions anyone. The comment
holds the status, a short Why, what happens next or who must act, and the last few changes folded
away. A pull request that only ever carries `loop:working` or `loop:skipped`, and one that no stage
spoke for, gets no comment.

## Alternatives Considered
- **A short new comment at each significant transition**: rejected by the user — it adds timeline
  entries, and a pull request that flips between states collects a trail of them. It would notify,
  which the user did not ask for.
- **Put the reason in the pull request description**: rejected — a description edit invalidates the
  standing review.
- **Leave the reason in the pass log**: the status quo; it reaches only the operator's machine.

## Consequences

### Positive
- A person sees why in one look, on the pull request, with no new notifications after the first.
- The comment never contradicts the label: every label change edits it.

### Negative
- An edit sends no notification, so a pull request that newly needs a person is not announced
  beyond the first comment. The tracking issue's status comment and the operator notifier still are.
- The history lives in the comment; a person who edits it loses the history.

## Enforced by
Invariant tests in `src/loop/status-comment.test.ts` (one comment, edits only, no write when only
numbers change, no comment for a pull request that was only working or skipped) and
`src/loop/loop.test.ts` ("the status comment in a pass": real whole passes only, and no stage's
decision changes because the comment exists). Whether the Why reads well stays judgment.

## Source
- Session: figure-out on the loop's label transitions, 2026-11-06
- Related: See also 20261015-loop-policy-read-from-target-base
