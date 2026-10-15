# agent-system

## Project surfaces

<!-- setup-project surfaces v4 -->

This project keeps its direction, vocabulary, and decision memory in the repo — shared
ground for every contributor and agent, regardless of tooling. Read `NORTH_STAR.md` and
`CONTEXT.md` at the start of every session.

- **NORTH_STAR.md** — why this project exists, who it's for, what winning means. Anchor on
  it scope, priority, outward claims, and any call the work's own contract does not settle —
  a mid-run pivot, whether to act on a review comment, what to leave alone. Each position
  carries a dated state
  (evidence / hypothesis / ruled / empty): new evidence may lower a state, but a
  position changes only by the owner's call, recorded as a decision record. The full
  form is `docs/NORTH_STAR_CONVENTIONS.md` — it is self-contained.
- **CONTEXT.md** — what words mean here. Read it before naming things; add a term when
  the project settles one.
- **docs/adr/** — why decisions went the way they did. Open `docs/adr/README.md` before
  settling a question the project may already have settled, and when a change
  contradicts or narrows an existing decision. Write new records per
  `docs/adr/CONVENTIONS.md` — it is self-contained, and writing one is one act: the
  record, the restatus of what it changes, and the index rebuild together.
- **Verification** — `scripts/verify`: how this project checks that its work still does its job.
  Run it before saying a change works, when reproducing a reported problem, and when a change
  touches something one of its recipes covers (`scripts/verify list` shows them); a change that
  needs a check no recipe has adds one. Recipes marked ask-first cost money, time, shared
  resources or effects outside the repository: run those only when a person runs them or has
  agreed. `scripts/verify --help` gives the rest.
