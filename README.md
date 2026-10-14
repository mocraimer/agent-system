# agent-system

Run coding agents on work you approved, and keep a record of what each run did.

agent-system is a command-line coordinator. You, the *operator*, approve work. It sends that work to Claude Code or Pi on your machine, or to Codex cloud or Claude Code web, keeps each run inside your subscription's allowance, and saves the evidence. A fresh install has no approvals, so it runs nothing until you add one.

[Explainer page](https://mocraimer.github.io/agent-system/) · [Operator guide](docs/OPERATING.md) · [Set it up with a coding agent](#set-it-up-with-a-coding-agent)

## What you can do

| You can | Start with | Read |
|---|---|---|
| Run one approved task on the runtime you choose | `agentsys approve`, then `agentsys dispatch` | [Approving one task](docs/OPERATING.md#approving-one-task) |
| Repair CI failures: a failed CI run becomes a job, and a standing grant lets matching repairs start without a new approval each time | `agentsys intake --event failure.json` | [Feeding events in](docs/OPERATING.md#feeding-events-in) |
| Work a repository's tickets with the ticket loop: shape tickets, open pull requests for the ones you grant, review and fix them, open a release pull request, verify the release | `agentsys loop arm --repo <path>` | [Ticket loop example](examples/ticket-loop/README.md), [The ticket loop](docs/OPERATING.md#the-ticket-loop) |
| Watch and steer in a local console in your browser, or print the same board in a terminal | `agentsys ui --repo <path>` | [Local control UI](docs/CONTROL-UI.md) |
| Connect a local agent to a stdio MCP server that reads status, jobs, usage, readiness and evidence, and can dispatch inside authority you already gave | `agentsys-mcp` | [Local MCP server](docs/MCP.md) |
| Keep evidence for every run, count outcomes, and replay frozen cases to compare configurations | `agentsys scorecards` | [Evidence and evaluation](docs/OPERATING.md#evidence-and-evaluation) |
| Hold work to your subscription's allowance and to a limit on paid provider calls | `agentsys usage`, `agentsys ledger` | [Subscription admission](docs/OPERATING.md#subscription-admission) |

## What it never does

- It never merges into `main`, turns on auto-merge, force-pushes, pushes to a base branch, runs a release, or deploys to production. It refuses these before it checks authority, so a grant written too broadly cannot reach them.
- It runs nothing on a fresh install. With no approval and no grant, every dispatch is held.
- It treats text that an agent or a forge wrote as data, never as an instruction. Only the operator creates or changes authority.
- One narrow merge exists and is off by default. The ticket loop can merge a pull request into `dev` only when the ticket's stop-line (how far the loop may take that kind of work) reaches the `dev` rung (5 in the example policy), an independent review of the current head is clean or has findings you accepted, `check-pr` reports the pull request ready, and you have granted `merge-dev`. A fresh install has no grants.

## How a run is checked

```text
request ──► authority ──► admission ──► runtime ──► evidence
            an approval    the job fits   Claude Code,   transcript,
            or a grant     your           Pi, Codex      checks,
            covers it      allowance      cloud, Claude  scorecard
                                          Code web
```

- **Authority** is permission for one dispatch. An *approval* covers one task. A *grant* covers a class of work until you narrow or revoke it.
- **Admission** compares the job with the allowance left in every usage window your subscription meters.
- Either check can refuse on its own.

## Before you start

You need:

- Node.js 22.12 or newer.
- At least one runtime from the table below, signed in.
- For the ticket loop: `gh` logged in as an account that can comment, label and open pull requests in the target repository.

### What each runtime needs

| Runtime id | Runs on | Needs |
|---|---|---|
| `claude-local` | Your machine | `claude` on `PATH` and signed in (`claude auth status`), with the manifest-dev plugins installed |
| `pi-local` | Your machine | `pi` on `PATH` and signed in to a provider, with the manifest-dev package installed for Pi |
| `codex-cloud` | Codex cloud | An environment id recorded with `agentsys config --codex-env <id>`, a working `codex login`, and a confirmed skill check (below) |
| `claude-web` | Claude Code web | An existing cloud session, recorded with `agentsys config --claude-cloud-session <id>` |

Every runtime sends a task through the manifest-dev `auto` skill unless you pass `--entry prompt`, which sends the prompt as written. Install the manifest-dev plugins for each runtime you use:

```bash
# Claude Code, inside a session
/plugin marketplace add doodledood/manifest-dev
/plugin install manifest-dev@manifest-dev
/plugin install manifest-dev-tools@manifest-dev
# Pi
pi install git:github.com/doodledood/manifest-dev
```

Two runtimes need more:

- **Codex cloud** refuses to dispatch until you confirm that its environment loads the manifest-dev skill. Get the environment to load it, watch a real cloud run enter the skill, then run `agentsys config --codex-skill-verified`.
- **Claude Code web** cannot create a session from a script. Create one by hand with `claude --cloud "<description>"` in a terminal. A dispatch there ends as `remote-uncertain`, not `completed`: open the session to read the result.

`agentsys loop arm` and `agentsys loop disarm` install and remove a systemd user service, so they need Linux with systemd. On another system, run a pass yourself with `agentsys loop --repo <path> --once`.

## Quick start

```bash
git clone https://github.com/mocraimer/agent-system.git
cd agent-system
npm ci
npm run build
npm install -g .
agentsys init --operator you@example.com
agentsys readiness --runtime claude-local
agentsys dispatch --task first-try --repo example-org/larkspur --class ci-repair \
  --runtime claude-local --profile default --actions author-changes \
  --estimate-five-hour 1 --estimate-weekly 1 --estimate-basis operator-bound \
  --prompt "should not run"
```

`npm install -g .` puts `agentsys` and `agentsys-mcp` on your `PATH`. If it fails with a permissions error, skip it and write `node dist/cli/main.js` wherever this guide says `agentsys`.

What you should see:

- `init` exits 0 and prints `Operator set to you@example.com. No autonomy grants are active.`
- `readiness --runtime claude-local` exits 0 and prints `claude-local: ready`, or exits 1 and prints `claude-local: NOT READY` with what is missing. Swap in the runtime you will use. Without `--runtime` it checks all four and exits 1 while any is not set up.
- `dispatch` exits 1 and prints `Awaiting approval (task first-try): No approval was supplied and there are no grants.` The refusal is the design: nothing runs without your approval.

Next, approve one task as [Approving one task](docs/OPERATING.md#approving-one-task) shows, or pick another job from [What you can do](#what-you-can-do).

## Set it up with a coding agent

Paste this to your coding agent. It installs and checks the tool, then stops at each step that needs you.

```text
Set up agent-system by following
https://raw.githubusercontent.com/mocraimer/agent-system/main/docs/AGENT-SETUP.md
Do the numbered steps in order and run only the commands the guide gives.
Ask me for the operator email and for the runtimes I will use; do not choose them.
Do not approve work, create grants, dispatch tasks or arm the loop. For each of
those, tell me what it needs and stop. End by reporting the result of every step.
```

The steps are in [docs/AGENT-SETUP.md](docs/AGENT-SETUP.md). The site's `llms.txt` lists the documents an agent can read.

## Documentation

- **[docs/OPERATING.md](docs/OPERATING.md)** — the operator guide: setup, authorizing work, model and effort selection, subscription admission, the paid-call ledger, evidence, evaluation, the ticket loop, updating and rollback, and cleanup.
- **[docs/MCP.md](docs/MCP.md)** — the local stdio MCP server: client setup, its seven tools, and the loopback-only control UI.
- **[docs/CONTROL-UI.md](docs/CONTROL-UI.md)** — the local operator console: its views, and what each action calls.
- **[docs/AGENT-SETUP.md](docs/AGENT-SETUP.md)** — numbered setup steps for a coding agent, with the expected result of each.
- **[docs/adr/](docs/adr/README.md)** — architecture decision records.
- **[examples/ticket-loop/](examples/ticket-loop/README.md)** — a worked example of running the loop against a product repository.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run test:ui      # browser tests (requires: npx playwright install chromium)
```

`npm test` also checks this README and the agent guide against the CLI: every command and flag they show must exist, the safe ones run in a temporary state directory, and every link must resolve. [docs/READER-TASKS.md](docs/READER-TASKS.md) lists the tasks readers do with these documents. See [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request.

The console screenshots in `docs/console-screens/` come from `ui-tests/console.spec.ts` (`npm run test:ui`), which writes them to `test-results/console-screens/`. [docs/CONTROL-UI.md](docs/CONTROL-UI.md#verification) has the copy command. Copy them to `site/assets/` as well; a test compares the two sets.

## License

MIT — see [LICENSE](LICENSE).
