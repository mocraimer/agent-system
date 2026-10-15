---
kind: feature
covers: src/adapters, src/commands.ts, src/core/run.ts, src/core/intake.ts, src/core/ci-intake.ts, src/core/store.ts, src/cli/main.ts, src/cli/args.ts
---
# Dispatch, runs and recovery

A task runs on one of four runtimes (local Pi, local Claude Code, Codex cloud, Claude Code web)
after authority and admission; its run is recorded, an interrupted one is reconciled rather than
assumed dead, and a CI failure event becomes one durable job however often it is delivered.

## How a user reaches it

- `agentsys dispatch`, `status`, `jobs`, `recover`, `reconcile`, `resolve-pi`, `intake`,
  `readiness`, `config`.
- The control UI's Advanced → Work view; the MCP `dispatch`, `status`, `jobs` and `readiness` tools.
- Every loop stage, which dispatches through the same path.

## Scenarios

### adapters
Run: `npm run --silent build && node --test dist/adapters/*.test.js`
Proves: each runtime's adapter against fake binaries and recorded fixtures — settings accepted or
refused, observed settings left unknown where the vendor confirms nothing, and Pi's stop proof.

### command-layer
Run: `npm run --silent build && node --test dist/commands.test.js dist/core/intake.test.js dist/core/ci-intake.test.js dist/core/store.test.js`
Proves: the typed command layer the CLI, UI and MCP share; duplicate deliveries reusing one job.

### cli
Run: `npm run --silent build && node --test dist/cli/cli.integration.test.js dist/cli/args.test.js`
Proves: the built `agentsys` end to end on a temporary state directory: fresh install, authority,
floor, admission, Pi stop, recovery and reconcile exit codes, check deferral.

## Gotchas

- The CLI integration tests run an installed `claude` or `pi` read-only for readiness and usage
  reads, so their timing depends on the machine; no task reaches a model.
- A real dispatch is the dispatch-real recipe, which is ask-first.
