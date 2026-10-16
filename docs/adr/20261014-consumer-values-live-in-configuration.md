# ADR: The public repository is the only upstream, and every consumer's values live in configuration

## Status
Accepted

## Area
Release and configuration

## Decided by
The user

## Context
agent-system was built while running one product's ticket store, and that product's values were
written into the code: the base branch its pull requests target, a cloud project nothing may write
to, the prefix of every hidden marker the loop writes, its deploy workflow's name, and the three
checks it runs after a release. Publishing the code meant either removing those values or
publishing a copy made for the purpose. The operator also runs the loop on that product, so
whatever the public code is must keep doing exactly what the loop does today.

## Decision
The public repository is the only upstream; the operator's own installation runs from it. Every
value that belongs to one consumer moves out of the code:

- The base branch a repository's integration pull requests must target, and the cloud projects
  nothing may write to, are the operator's floor (`agentsys floor`, stored in the state directory).
  The store configuration cannot hold the base, because the loop reads that file from the base.
- The marker prefix, the release branch, the deploy workflow, the deploy scope command and the
  post-deploy checks are the target repository's, in its `tickets/store-config.md` under
  *Coordinator protocol* and *Release checks*. The marker prefix is required, so a loop pointed at
  a store configuration that does not name it stops instead of failing to recognise its own
  comments.

The change was accepted only after a dry-run pass of the new build over the operator's real store
decided every item the same way as the old build.

## Alternatives Considered
- **Keep a private main line and publish cleaned copies from time to time**: rejected — each copy
  needs cleaning again, the public code drifts from what actually runs, and the decoupling would
  never be tested by real use.
- **Publish the existing repository by changing its visibility**: rejected — its history, pull
  requests and issues carry the product's private details, and rewriting history cannot clean
  pull request and issue bodies.
- **Default the marker prefix**: rejected — a default would let an installation updated before its
  store configuration silently stop recognising every comment it had written.

## Consequences

### Positive
- Anyone can point the loop at their own repository by writing a store configuration and setting
  their floor; nothing in the code assumes a particular product.
- The operator's installation exercises the public code on every pass.

### Negative
- A store configuration has one more required row.
- The post-deploy checks are expressed as commands with placeholders, which is less specific than
  code written for one product: a check's special exit meanings beyond pass, fail and blocked are
  no longer described in its result.

## Enforced by
partly — `src/core/authority.test.ts` "the floor: constrained PR bases" and "the floor: read-only
projects" hold the base branch and read-only projects in the floor;
`src/cli/documented-setup.integration.test.ts` "holds no required base or read-only project in a clean
state directory" holds that the code carries no consumer's values; `src/loop/loop.test.ts` "refuses a
store configuration with no marker prefix, so a loop cannot run blind to its own comments" holds the
required marker prefix, and its post-deploy tests hold the deploy workflow and release checks. Not
held by any check: a configured release branch other than `main`, and the deploy scope command.

## Source
- Session: open-source release investigation and manifest, 2026-10-14
- Related: 20261014-default-queue-rules-built-in
