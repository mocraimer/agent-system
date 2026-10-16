---
kind: feature
covers: src/mcp
---
# The local MCP server

A stdio MCP server (`agentsys-mcp`) exposing status, jobs, usage, readiness, evidence, evaluation and
bounded dispatch through the same command layer as the CLI, and no authority or policy changes.

## How a user reaches it

- `claude mcp add --transport stdio ... node <checkout>/dist/mcp/server.js`, or the Pi adapter setup in
  docs/MCP.md; `npm run mcp` starts it by hand.

## Scenarios

### unit
Run: `npm run --silent build && node --test dist/mcp/server.test.js`
Proves: the protocol handshake, each tool's output, and that dispatch cannot name an operator or
create authority.

## Gotchas

- Protocol JSON goes to stdout only; anything else printed there breaks the client.
