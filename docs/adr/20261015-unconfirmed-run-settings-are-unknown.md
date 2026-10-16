# ADR: What a runtime does not confirm is recorded as unknown, and requested, resolved and observed settings are kept apart

## Status
Accepted

## Area
Run evidence

## Decided by
The user

## Context
Runtimes differ in what they report back. Codex cloud accepts no model or effort and reports
neither. Claude Code web accepts both but answers a dispatch with an acknowledgement that carries
neither. Local Claude Code names the model that billed but no effort. Scorecards, the trust report
and the improve stage all read what a run recorded.

## Decision
A run records three things separately: what the caller requested, what was resolved after the
approval's tier and the runtime's default applied, and what the runtime observed. Where the runtime
does not confirm a setting, the observed value is `unknown`. It is never filled in by echoing the
request, because, in the guide's words, that "would manufacture evidence for a configuration nobody
confirmed".

## Alternatives Considered
_Not recovered._

## Consequences

### Positive
- The record never claims a configuration nobody checked, so comparisons across tiers rest only on
  what was confirmed.

### Negative
- Runs on Codex cloud and Claude Code web carry `unknown` settings, which limits what their
  scorecards can say about a tier.

## Enforced by
`src/adapters/types.test.ts` "what a run records about what actually ran" ("records unknown where the
vendor reports nothing", "keeps unknown even when a caller passes a guess"), and
`src/adapters/claude-web.test.ts` "records the effective model and effort as unknown, not as what was
asked for".

## Source
- Retroactive — `docs/OPERATING.md` "Choosing a model and effort" and "The tier an approval names",
  in the initial public release (commit 236c775).
- Session: (no session — captured post-hoc during project setup, 2026-10-15)
