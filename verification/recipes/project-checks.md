---
kind: check
covers: src, ui-tests, scripts, eslint.config.js, tsconfig.json, package.json, package-lock.json
---
# Project checks

The checks CI runs on every pull request: types, lint, the whole node suite, and the fresh-install
refusal. Run these before saying a change works; the feature recipes below run one area at a time.

## How a user reaches it

- `npm run typecheck`, `npm run lint`, `npm test` (builds first), as CONTRIBUTING.md lists.
- CI runs the same, then `scripts/check-fresh-install-refusal.sh`, on every pull request to `main`.

## Scenarios

### typecheck
Run: `npm run --silent typecheck`
Proves: the TypeScript project compiles with the strict settings in tsconfig.json.

### lint
Run: `npm run --silent lint`
Proves: ESLint passes over src, scripts and examples.

### node-suite
Run: `npm test`
Proves: the build succeeds and every node test passes, including `verify check`.

## Gotchas

- `npm run test:unit` skips the build and runs whatever is in dist/, which may be stale.
- The browser suite (`npm run test:ui`) is not part of `npm test`; see the operator-console and
  control-ui recipes.
