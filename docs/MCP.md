# Local MCP and control UI setup

This package exposes the coordinator as a local stdio MCP server. It is a local
client integration, not a hosted or public HTTP service. The server uses the same
`AGENTSYS_STATE` directory and typed command path as `agentsys`.

## Start the MCP server

Build from the agent-system checkout:

```bash
npm run build
```

The server executable is at:

```bash
<checkout>/dist/mcp/server.js
```

The server reads newline-delimited JSON-RPC on stdin and writes protocol JSON
only to stdout. Diagnostics go to stderr. Set `AGENTSYS_STATE` before starting it
when the installation uses a state directory outside the current working tree.

## Claude Code

Claude Code documents local stdio servers with `claude mcp add --transport stdio`.
Run this from the project that should receive the server. `--scope project` writes
project configuration rather than the operator's user configuration:

```bash
claude mcp add --scope project --transport stdio agent-system -- \
  node /path/to/agent-system/dist/mcp/server.js
claude mcp get agent-system
```

Review and approve a project-scoped `.mcp.json` in an interactive Claude Code
session when Claude asks. Do not put credentials in this entry. The server uses
the local process environment only for its existing coordinator/vendor setup.
Claude Code sets `CLAUDE_PROJECT_DIR` for local stdio servers; this server uses its
launch directory for the default checkout and `AGENTSYS_STATE` for durable state,
so set those explicitly when launching from another directory.

The command above is a configuration example, not a command run by this build or
test. Verification here does not modify `~/.claude.json`, `.mcp.json`, or any
operator-global Claude configuration.

## Pi

The supported Pi coding-agent documentation says that upstream Pi has no built-in
MCP client and that MCP support is supplied by an extension or adapter. This
installation's Pi harness already supplies that adapter. Configure that adapter's
project/local stdio entry with the same command:

```text
node /path/to/agent-system/dist/mcp/server.js
```

Do not treat the upstream Pi core as proof that the server is connected, and do
not change `~/.pi/agent/mcp.json` as part of this setup. The protocol test below is
the client-independent check; the adapter's own supported connection/listing
check is the Pi-side check. Pi's existing `pi --mode rpc` integration remains a
separate agent runtime and is not replaced by this server.

## Available tools

The server advertises exactly these seven tools:

| Tool | Use |
|---|---|
| `status` | Durable runs, elapsed time, and reservations. |
| `jobs` | Jobs, duplicate deliveries, obligations, and evidence directories. |
| `usage` | Runtime account usage, policy thresholds, reset context, and reservations. |
| `readiness` | Runtime setup and capability status. |
| `evidence` | Required checks and candidate evidence aggregation. |
| `evaluation` | Scorecards, frozen suites, trials, and raw configuration comparisons. |
| `dispatch` | One bounded task through authority, recovery, admission, and the selected adapter. |

All view calls are read-only. `usage` may contact the vendor's supported usage
interface, but it does not change coordinator state except for the existing
admission path's normal reading record when that path is used. `evidence` uses the
server clock and the configured freshness policy; a client cannot make stale
evidence fresh by supplying a different clock or age limit.

## Dispatch safety

`dispatch` accepts task metadata, actions, prompt, optional pre-existing
`approvalId` or grant `triggerSource`, runtime settings, and a bounded usage
estimate. It does **not** accept `as`, `operator`, or `actor`. It has no tool for
creating, widening, narrowing, revoking, or self-approving authority; no tool for
changing policy, checks, the paid-call allowance, or active versions; and no
merge, force-push, release, or production-deploy action.

A dispatch without a matching existing approval or active grant returns
`awaiting-approval` with `proposal.issued: false` and an operator command path.
It does not write an approval or mint a confirmation credential. The operator
must review the exact scope through the CLI, then provide the resulting approval
through the operator's normal controlled workflow. A matching grant still needs
its configured event source; a missing or unapproved source stays pending/refused.

A local shell process under the same OS identity is not a security sandbox. Do not
run this server with credentials or a checkout whose write access exceeds what the
operator is willing to give the connected client. MCP transport locality does not
turn an agent into the operator.

## Honest results

The structured result retains coordinator outcomes rather than flattening them:

- `awaiting-approval` is pending authority, not a failed runtime call.
- `quota-waiting` includes missing/stale/unavailable usage or an estimate that does
  not fit; unknown usage is never zero.
- `remote-uncertain` keeps the session and reservation visible until the vendor
  confirms what happened; it is not completion.
- `evidence` reports missing, stale, failed, skipped, inaccessible, superseded,
  wrong-class, configuration-mismatch, and deferred checks separately.
- A deferred check is named as untested and not passed. `enforceDeferred` asks for
  that check back for the current view; it cannot remove a required check.
- Evaluation returns raw counts and per-case outcomes, not a reliability rate or
  an automatic authority decision.

## Local operator UI

The separate local control UI is started through the CLI after building:

```bash
agentsys ui
# or, without installing the package:
node /path/to/agent-system/dist/cli/main.js ui
```

It binds to loopback, prints its URL, and stays alive until Ctrl-C. Setup and
configuration (`init`, vendor session ids, and policy defaults) remain CLI-only.
This UI is local operator tooling; it is not the MCP transport and must not be
exposed as a public HTTP service.
