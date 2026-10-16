# ADR: The loop's policy lives in the target repository's store configuration, read from the fetched base branch on every pass

## Status
Accepted

## Area
Ticket loop

## Decided by
The user

## Context
The loop decides how far each piece of work goes, which tiers run each stage, its limits and its
review ladder. Other sessions work in the target repository's checkout and switch branches there.

## Decision
Everything about how far work goes and who reviews it is read from the target repository's
`tickets/store-config.md` on every pass; the coordinator holds no copy. The file, and any queue rule
modules, are read from the fetched base branch, never from the working tree, because "other sessions
may switch branches there". `--policy-ref` reads them from another ref to try a change before it
merges. A policy change is therefore a commit to the target's base branch.

## Alternatives Considered
_Not recovered._

## Consequences

### Positive
- The next pass picks up a merged policy change with no coordinator release.
- A branch checked out in the target's working tree cannot change what the loop does.

### Negative
- A policy change needs a merge in the target repository, and an older coordinator build reads the
  file as it understood it, which the guarded upgrade procedure in `docs/OPERATING.md` has to manage.

## Enforced by
partly — the loop's `Repo` interface in `src/loop/git.ts` offers reads only at a ref (`show`, `has`),
and `src/loop/pass.ts` reads the store configuration through it at the policy ref; no test pins that
an edit in the target's working tree is ignored.

## Source
- Retroactive — `docs/OPERATING.md` "Where its policy comes from", and the comment on `Repo` in
  `src/loop/git.ts`, in the initial public release (commit 236c775).
- Session: (no session — captured post-hoc during project setup, 2026-10-15)
- Related: 20261014-default-queue-rules-built-in, 20261014-consumer-values-live-in-configuration
