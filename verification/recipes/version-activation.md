---
kind: feature
covers: src/core/version.ts, src/core/build.ts, scripts/stamp-build.mjs
---
# Version activation and rollback

A build becomes the running system only when the operator activates it and names a merged pull
request; an unmerged build can be recorded as a candidate without touching the active version.

## How a user reaches it

- `agentsys version show|candidates|history|record-candidate|activate|rollback`.
- `scripts/deploy.sh [--restart]` puts a merged change in front of the armed loop.
- The control UI's Advanced → Safety view.

## Scenarios

### unit
Run: `npm run --silent build && node --test dist/core/version.test.js dist/core/build.test.js`
Proves: candidates never activate, agents cannot activate or roll back, the operator needs a
confirmed merge, rollback keeps the prior version, a run keeps the version it started with, and the
build stamp is read honestly.

## Gotchas

- `scripts/deploy.sh` fetches, fast-forwards this checkout and can restart the service; it is not a
  scenario here.
