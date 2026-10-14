# ADR: Default queue rules are built in, and a target repository may override them

## Status
Accepted

## Area
Ticket loop

## Decided by
The user

## Context
The loop decides which tickets need shaping, which await a verdict, which are ready and what
counts as a claim by queue rules. Until now those rules lived only in the target repository, in
`scripts/agent-system/shape-candidates.mjs` and `auto-candidates.mjs`, and the coordinator held no
copy — so that a repository could change its rules without a coordinator release. In practice the
coordinator already repeated part of them: the claim, shape and assessment markers, and the claim
line in the sweep prompt. A new user had no reference implementation and would have to write
sixteen exports before the loop could run.

## Decision
The coordinator ships the rules of the manifest-dev ticket convention as its default, under the
repository's marker prefix. A repository that commits both modules on its base branch replaces
the default entirely; one module without the other is an error. This narrows the principle that
"the coordinator holds no copy" of a repository's queue rules: it holds a default, and the
repository's own copy still wins.

## Alternatives Considered
- **Ship the rules only as example files the adopter copies**: rejected — it keeps the principle
  intact on paper, but every adopter copies and maintains sixteen exports, and the coordinator's
  own repeated markers stay duplicated.

## Consequences

### Positive
- A repository that follows the convention needs no code of its own to run the loop.
- The marker names derive from one setting instead of being repeated across the code.

### Negative
- A change to the convention's default rules now needs a coordinator release for repositories that
  rely on the default.

## Source
- Session: open-source release investigation and manifest, 2026-10-14
- Related: 20261014-consumer-values-live-in-configuration
