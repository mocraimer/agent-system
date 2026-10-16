---
kind: data
covers: docs/model-effort-rungs.md, src/eval/rungs.ts, src/eval/refresh-rungs.ts
---
# Model and effort rungs

A dated reading of a published model comparison, kept so the operator choosing a tier sees the
trade-off; nothing consults it at dispatch.

## How a user reaches it

- Reading docs/model-effort-rungs.md; `npm run rungs:refresh` to compare it with the source.

## Scenarios

### refresh
Run: `npm run --silent rungs:refresh`
Proves: the table still matches the source page; a non-zero exit names each moved rung or untracked
model family, and the table then needs an update by hand.

## Gotchas

- It fetches one public web page and needs the network; `node dist/eval/refresh-rungs.js --from
  <saved.html>` runs offline against a saved copy.
- It never rewrites the file without `--write`.
