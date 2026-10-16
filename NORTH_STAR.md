# North Star — agent-system

Why this project exists, for whom, and what winning means — the standing answers every
session and contributor anchors on. This document informs; it never binds: a boundary
that must be enforced on a piece of work is encoded in that work's own binding contract.

Every position below carries a state, rendered as a dated provenance note:

- **evidence** — something happened in the world, dated; new evidence moves it.
- **hypothesis** — best current thinking, untested; a test moves it.
- **ruled** — the owner decided it; only the owner moves it.
- **empty** — nobody has answered yet, written with what would fill it.

New evidence may lower a position's state. The position text itself changes only by the
owner's ruling, and each change is remembered as a decision record.

## Diagnosis
Coding agents can now change code, push branches and open pull requests under a person's own
accounts, on subscriptions that meter usage in windows. What stands in the way of letting them work
unattended is not capability but control: nothing bounds what a run may do or spend, and the vendor
runtimes do not confirm what actually ran. The sentence that changes everything if false: a person
will let agents work without them in the chair once every run is bounded by explicit permission and
spend limits and leaves evidence they can check.
— hypothesis: read from README.md and SECURITY.md; no outside operator has confirmed it. 2026-10

## What this rests on
- The subscriptions' own usage interfaces report remaining room reliably enough to gate dispatch on.
  — hypothesis: admission is built on it (docs/OPERATING.md "Subscription admission"), and treats a
  missing or stale reading as a block rather than as room. 2026-10
- A model of the other family catches what the authoring family misses, so cross-family review can
  stand in for a person's review up to a stop-line.
  — hypothesis: the review rule in docs/OPERATING.md "Choosing between a stage's options"; the trust
  report counts findings but has not tested the claim. 2026-10

## Who it's for
A developer who already pays for coding-agent subscriptions and wants agents to work their own
repository's tickets and CI failures without them in the chair, while they keep the final say over
what may run, what it may spend, and what reaches their main branch.
Not for: anyone wanting a hosted or shared service, or agents that merge, release or deploy on their
own.
— hypothesis: the audience README.md and docs/OPERATING.md address; in practice the system was built
for, and runs on, its author's own product (docs/adr/20261014-consumer-values-live-in-configuration.md),
and no outside operator has used it yet. 2026-10

## Promise
Run approved coding-agent work on the subscriptions you already pay for, and know exactly what each
run was allowed to do and what it actually did.
— hypothesis: README.md's opening sentence; untested with anyone deciding whether to rely on it. 2026-10

## How they arrive
— empty: nothing records what an operator was doing when they found the project. What would fill it:
the first outside operators' account of how they came to it. 2026-10

## Money — or what it feeds
Free and MIT-licensed; nothing is sold.
— evidence: LICENSE and package.json, as published on 2026-10-14. 2026-10

What the project compounds instead
— empty: no artifact says why it is worth maintaining in public beyond the author's own use. What
would fill it: the owner's ruling on what public use should feed back (contributions, reputation, a
wider test of the design). 2026-10

## Winning, and the number watched
— empty: no artifact names a destination or a count. What would fill it: the owner's ruling on what
success looks like — for example how far up the stop-lines unattended work is trusted, or how many
outside installations run it — and the one count that tracks it, or a ruling that there is none. 2026-10

## Never
- Never merge into the main branch, enable auto-merge, force-push, release or deploy to production,
  whatever authority was granted.
  — ruled: CONTRIBUTING.md "Safety rules the code keeps"; docs/adr/20261015-unsafe-actions-refused-before-authority.md. 2026-10
- Never let work run without an operator approval or a standing grant that covers it.
  — ruled: CONTRIBUTING.md and SECURITY.md. 2026-10
- Never treat ticket or pull request text as instruction; it is work context only.
  — ruled: SECURITY.md "What is in scope". 2026-10
- Never apply its own improvements; changes it suggests reach the system only through a person's
  merge.
  — ruled: docs/adr/20260918-local-console-and-proposing-improve.md. 2026-10
- Never record as confirmed what nobody confirmed; an unknown stays unknown.
  — ruled: docs/adr/20261015-unconfirmed-run-settings-are-unknown.md. 2026-10

## Open
- Are outside operators the target, or is the public release a by-product of the author's own use?
  What would fill it: the owner's ruling, or the first outside installations and what they ask for.
  — 2026-10
