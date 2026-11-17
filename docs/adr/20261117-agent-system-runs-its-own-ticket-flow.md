# ADR: agent-system runs its full ticket flow on its own repository, through the same three gates

## Status
Accepted

## Area
Ticket loop

## Decided by
The user

## Context
agent-system ran its ticket loop on one repository, SmartCaptions, and had never run it on itself: it has
no ticket store, no issue and no loop grant of its own. Its own changes came from the owner's sessions, so
a defect in the factory was felt on SmartCaptions and fixed by hand. The owner asked what dogfooding
should cover.

## Decision
The owner ruled on 2026-11-13 that agent-system runs its **full ticket flow** on its own repository,
`mocraimer/agent-system`, beside SmartCaptions on the one installation: a change goes ticket, loop, pull
request, and the owner's merge. It passes the same three operator gates as SmartCaptions: accepting a
proposal with `shaped`, granting work with `auto`, and merging. Merge and deploy stay the owner's.

The setup the investigation chose, which the owner may revise, is `main` only: `main` is both the base
and the release branch, and every ticket type stops at rung 4, a reviewed and clean pull request. The
merge, release and verify stages then have nothing to do. The loop for this repository is armed on its
own clone, and the workers the loop starts get a state directory of their own.

## Alternatives Considered
- **Tracking only**: keep tickets for agent-system's work on GitHub with no loop acting on them. Not
  chosen; the owner took the full flow.
- **The improve stage only**: let the loop propose prompt and tier changes to agent-system and nothing
  else. Not chosen; the owner took the full flow.
- **A `dev` branch beside `main`**: not weighed with the owner. It would add a second visit from the owner
  for every change, and it stays open as a revision of the setup above.

## Consequences

### Positive
- A defect in the factory is found by the factory's own loop, on the repository that holds the fix.
- The first work through the flow is the failure-handling changes, so the flow is tested on work that
  matters.

### Negative
- Every pull request to this repository, the owner's included, is reviewed by the loop after a quiet
  period, up to a limit, and the reviews spend subscription room that SmartCaptions also uses.
- Two loops share one ledger and one set of subscriptions, so each one's admissions wait on the other's.

## Enforced by
partly — `src/loop/agent-system-store.test.ts` ("merges nothing into main even with every stop-line
raised to 5 and a merge grant in place") holds that nothing can merge into agent-system's `main`; the
choice to run the full flow, and the three gates, stay judgment.

## Source
- Session: the figure-out session of 2026-11-13 for the failure-handling work, owner ruling at 10:35Z.
- Related: 20261015-unsafe-actions-refused-before-authority, 20261117-agent-system-is-judged-as-a-tool-for-an-operator
