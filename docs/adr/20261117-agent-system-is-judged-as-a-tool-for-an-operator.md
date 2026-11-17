# ADR: agent-system is judged as a tool for an operator, and adoption is not pursued

## Status
Accepted

## Area
Project direction

## Decided by
The user

## Context
`NORTH_STAR.md` left one question open: are outside operators the target, or is the public release a
by-product of the author's own use? The repository has been public since 2026-10-14 and has no outside
installation. In practice it was built for, and runs on, its owner's own product, SmartCaptions.

## Decision
The owner ruled on 2026-11-13 that agent-system is judged as a tool for other operators, with
SmartCaptions as its test bed, and that adoption by outside operators is not pursued: in the owner's
words, "if it is adopted great otherwise we are the outside operator". The owner is that operator. What
agent-system does is judged by how well it serves an operator who runs it on their own repositories, and
no work is done to bring operators to it.

The owner gave no reason for choosing this over the alternatives, and none is reconstructed here.

## Alternatives Considered
- **Verified ships per owner-hour**: judge the factory by how much reviewed work it lands per hour of the
  owner's time. It was the recommendation put to the owner. Not chosen; no reason was given.
- **SmartCaptions growth**: judge it by what it does for the product it runs on. Not chosen; no reason
  was given.
- **Hands-off maintenance**: judge it by how little the owner has to do to keep it running. Not chosen;
  no reason was given.
- **Adoption work**: a clean-room install walk, research into how an operator arrives, and polish of the
  first run. The owner's answer was "No need for this". Not chosen.

## Consequences

### Positive
- A change is weighed by whether an operator can run, trust and read the system, not by who has adopted it.
- Nothing is built to chase installs, stars or arrivals.

### Negative
- Nobody checks that an outside operator can get started. The documentation and examples stay as good as
  the owner's own use makes them.
- The North Star's "Who it's for" and "How they arrive" stay as they are: this ruling does not name an
  outside operator, so they remain a hypothesis and empty.

## Enforced by
none — a statement of whom the project is judged against, which no check can hold; a session reads it in
`NORTH_STAR.md` and `docs/adr/README.md`.

## Source
- Session: the figure-out session of 2026-11-13 for the failure-handling work, owner ruling at 08:55Z and
  09:40Z.
- Related: 20261117-agent-system-runs-its-own-ticket-flow
