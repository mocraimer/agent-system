# ADR: Prompt proposals open only in a repository the floor names

## Status
Accepted

## Area
Ticket loop

## Decided by
The user

## Context
The improve stage proposes a prompt change as a pull request in the coordinator's own repository,
found from the checkout's `origin`. The body quotes what it ranked and why: the target
repository's name, its base commit, local paths, and the drafting run's reasoning about the
target's work. While the coordinator lived in a private repository, that was where its operator
alone could read it. Once the coordinator's upstream is public, an operator with push rights who
runs the loop from a clone of it would publish their private target's details in every proposal.

## Decision
The floor gains one setting, `promptProposals`: the repository, by `owner/name`, the improve stage
may open prompt-change pull requests in. The stage opens one only when the coordinator checkout's
`origin` is that repository. Otherwise it writes the drafted template and the pull request body to
the loop's state directory and reports where. A fresh install names none, so nothing leaves the
machine until the operator says where it may go.

## Alternatives Considered
- **Turn the improve stage off in the target's store configuration**: set aside — it removes the
  stage for one operator and leaves the same exposure for every other operator of the public code.
- **Keep the running checkout on a private repository and pull public changes into it**: set
  aside — it keeps a second upstream alive, against
  [the public repository being the only one](20261014-consumer-values-live-in-configuration.md).

## Consequences

### Positive
- A coordinator run from a public upstream never posts a target's details there by default.
- The setting sits with the other limits no approval or grant can relax.

### Negative
- An operator who wants prompt pull requests names the repository once, and a checkout whose
  `origin` differs gets drafts, not pull requests.

## Enforced by
`src/loop/improve.test.ts` "proposes prompts in the coordinator's own repository only when the floor
names it" and "saves a prompt draft in the state directory, and opens nothing, when no coordinator
repository is named for proposals"; `src/cli/documented-setup.integration.test.ts` "holds no required
base or read-only project in a clean state directory" holds that a fresh floor names no repository.

## Source
- Decided during the first public release, on 2026-10-14, after a prompt proposal on the private
  repository was found to quote the target's name, paths and incident evidence.
