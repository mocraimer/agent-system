# agent-system

An operator-controlled coordinator that runs approved coding-agent tasks on local Claude Code, local
Pi, Codex cloud and Claude Code web, keeps durable evidence of what each run did, and runs a ticket
loop over a target repository's GitHub issues.

## Language

**Operator**:
The single identity an installation answers to, set once with `agentsys init`. Only the operator
creates or changes authority; anything an agent writes is data, however it is phrased.
_Avoid_: User, admin.

**Authority**:
Permission for one specific dispatch. It takes two shapes: an **approval** covers one task; a
**grant** covers a class of event-triggered work, from named sources, until it is narrowed or
revoked. A grant can only be narrowed in place; widening means revoking it and issuing a new one.

**Admission**:
The check, separate from authority, that a job fits the subscription's remaining room in every window
that subscription meters, after reservations and the safety margin. Either check can refuse on its
own.
_Avoid_: Quota check, budget check.

**Floor**:
Per-installation limits no approval or grant can relax: the base branch a repository's pull requests
must target, cloud projects nothing may write to, and the repository prompt proposals may open in.
Set with `agentsys floor`, stored in the state directory.
_Avoid_: Policy (that is admission thresholds), store configuration (that is the target's).

**Store configuration**:
The target repository's `tickets/store-config.md`, read from its fetched base branch on every pass:
the loop's whole policy — rungs, stop-lines, stage tiers, limits, review ladder, coordinator protocol
and release checks. The coordinator holds no copy.

**Effort**:
In the ticket store, a group of tickets sharing one tracking issue and an `effort:<slug>` label. Not
the same as a model's **effort** setting (`low` … `max`), which is part of a tier. Say "effort
setting" or "reasoning effort" for the second.

**Tier**:
One runtime, model and effort setting a stage or approval can run on, e.g. `gpt-6.1-sol · max on
pi-local`. A stage may list several tiers; each dispatch picks one.

**Rung**:
One step on the store configuration's ladder of how far work may go, from shaping to verifying a
release.

**Stop-line**:
The highest rung the loop may take a ticket of a given type to; every rung past it is a person's.
Raising one is a store configuration edit.

**Pass**:
One run of the loop over the store: it reads the store once, takes each stage in order, decides
dispatch, skip or blocked for every item, and ends with one classification (`idle-empty`,
`progress`, `waiting`, `blocked`, `stalled`, `breach`).

**Stage**:
A named step of a pass — shape, assess, sweep, review, fix, merge, close, release, verify — plus the
separately scheduled improve stage.

**Outside pull request**:
A pull request whose head branch is not `ticket/<n>`: the loop did not open it. The loop reviews it
only after a quiet period and up to a review limit, and leaves fixing and merging to its author.

**Independent review**:
A review by a model of the other family from the pull request's author. A same-family fallback is
marked `independent=no` and does not count toward a merge.

**Derived verdict**:
A verdict read from a person's acts on GitHub (a merge, a label, an edit), recorded on a scorecard
with the store event behind it. An **explicit verdict** is one the operator records; it supersedes
the derived ones as the scorecard's current verdict. Counts show the two apart and never add them.

**Remote-uncertain**:
A run whose end nobody has confirmed. It keeps its subscription reservation and blocks a second
attempt at the same job until it is resolved.
_Avoid_: Failed, completed.

**Knob**:
A stage on a tier with a prompt digest: the unit the improve stage ranks and proposes one change to
at a time.

## Relationships

- Every dispatch needs both **Authority** and **Admission**; the **Floor** is checked before either.
- A ticket's **Stop-line** is one **Rung**; each **Stage** of a **Pass** acts only up to it.
- A **Knob** is one **Stage** on one **Tier**.

## Flagged ambiguities

- "effort" means both a ticket group and a model setting — resolved: **Effort** alone is the ticket
  group; the model setting is the "effort setting".
