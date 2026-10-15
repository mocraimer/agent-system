---
kind: docs
covers: docs/OPERATING.md, docs/MCP.md, docs/CONTROL-UI.md, README.md, src/cli/main.ts
---
# The operator guide matches the system

docs/OPERATING.md and the setup it walks through, checked against the code: every outcome label,
every command `--help` advertises, the defaults it quotes, and the documented setup order.

## How a user reaches it

- Reading docs/OPERATING.md, docs/MCP.md, docs/CONTROL-UI.md and the README.
- `agentsys --help`.

## Scenarios

### guide-matches-code
Run: `npm run --silent build && node --test dist/cli/docs.test.js`
Proves: outcome labels, command names, admission defaults, the allowance, effort levels, loop
classifications and the forbidden actions in the guide match the code.

### documented-setup
Run: `npm run --silent build && node --test dist/cli/documented-setup.integration.test.js`
Proves: the setup order in the guide works from a clean state, and the code assumes no particular
consumer.

## Gotchas

- The docs test checks command names, not flags: a flag missing from `agentsys --help` or the guide
  passes it.
