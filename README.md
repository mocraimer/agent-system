# agent-system

An operator-controlled coordinator for running approved coding-agent tasks on
local Claude Code, local Pi, Codex cloud, and Claude Code web, and keeping durable
evidence of what each run actually did.

Every dispatch clears two independent checks: **authority**—an operator approval
or an active standing grant covers this exact work—and **admission**—the job fits
inside the subscription's remaining allowance in every window that subscription
meters. A fresh install has neither an approval nor a grant, so it starts by
declining to run anything.

Merging, auto-merge, force-pushing, releases, and production deploys are refused
before authority is consulted, so an over-broad grant still cannot reach them.

## Prerequisites

- **Node.js ≥ 22.12**
- **`gh`** logged in as an account that can comment, label, and open pull requests in the target repository
- Per runtime:

| Runtime | What it needs |
|---|---|
| Local Claude Code | `claude` on `PATH`, signed in (`claude auth status`) |
| Local Pi | `pi` on `PATH`, signed in with a provider; the [manifest-dev](https://github.com/doodledood/manifest-dev) plugin installed (`pi install git:github.com/doodledood/manifest-dev`) |
| Codex cloud | A cloud environment id, and a working `codex login` |
| Claude Code web | An existing cloud session id, recorded with `agentsys config --claude-cloud-session <id>` |

The ticket loop's prompts use manifest-dev skills (`run-ticket`, `define`, `review-pr`,
`check-pr`) on every runtime it dispatches to.

## Quickstart

```bash
npm install
npm run build
node dist/cli/main.js init --operator you@example.com
node dist/cli/main.js readiness
```

`readiness` checks every runtime and exits 1 while any of them is not set up, naming
what each one still needs. You only need the runtimes you will dispatch to;
`readiness --runtime <rt>` checks one.

After that, `agentsys` is available as a command if you install the package, or run
`node dist/cli/main.js` from the checkout.

## Documentation

- **[docs/OPERATING.md](docs/OPERATING.md)** — operator guide: setup, authorizing work, model and effort selection, subscription admission, the paid-call ledger, evidence locations, evaluation, the ticket loop, updating and rollback, and cleanup.
- **[docs/MCP.md](docs/MCP.md)** — local stdio MCP server: client setup, tool boundary, and the loopback-only control UI.
- **[docs/CONTROL-UI.md](docs/CONTROL-UI.md)** — the local operator console: views, actions, and what each one calls.
- **[docs/adr/](docs/adr/)** — architecture decision records.
- **[examples/ticket-loop/](examples/ticket-loop/)** — a worked example of running the loop against a product repository.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run test:ui      # browser UI tests (requires: npx playwright install chromium)
```

Console screenshots in `docs/console-screens/` are produced by `ui-tests/console.spec.ts`
(`npm run test:ui`) and copied from `test-results/console-screens/`. See
[docs/CONTROL-UI.md](docs/CONTROL-UI.md) for the exact copy command.

## License

MIT — see [LICENSE](LICENSE).
