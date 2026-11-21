---
kind: feature
covers: src/core/version.ts, src/core/build.ts, scripts/stamp-build.mjs, scripts/deploy.sh
---
# Version activation and rollback

A build becomes the running system only when the operator activates it and names a merged pull
request; an unmerged build can be recorded as a candidate without touching the active version.

## How a user reaches it

- `agentsys version show|candidates|history|record-candidate|activate|rollback`.
- `scripts/deploy.sh [--restart]` puts a merged change in front of every armed loop.
- The control UI's Advanced → Safety view.

## Scenarios

### unit
Run: `npm run --silent build && node --test dist/core/version.test.js dist/core/build.test.js`
Proves: candidates never activate, agents cannot activate or roll back, the operator needs a
confirmed merge, rollback keeps the prior version, a run keeps the version it started with, and the
build stamp is read honestly.

### deploy
Run: `npm run --silent build && node --test dist/loop/deploy.test.js`
Proves: `scripts/deploy.sh --restart` on a scratch checkout with its own origin restarts every armed
loop (the one an older build armed and one per repository), leaves one with a model run in flight and
exits 3, says so when none is armed, and rolls back by restoring the `dist` it backed up.

## Gotchas

- The deploy scenario runs the script against a scratch checkout with `systemctl` stubbed; a real
  deploy fetches and fast-forwards this checkout and restarts real services, which only the operator
  does.
