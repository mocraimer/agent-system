# Reader tasks

These are the tasks a reader comes to the agent-system documents to do. Each entry names the documents the task must be doable from, so a change to a document can be checked against the tasks that depend on it.

## How a task is walked

A reader with fresh context walks one task at a time: no memory of this repository, only the documents the task names. The reader works in a clean clone with a temporary state directory (`AGENTSYS_STATE` set to an empty directory), never runs `agentsys usage` (it prints a real account id), and records where it got stuck. A task passes when the reader ends up able to do what the entry says without a step the documents leave out.

## Statuses

- `unverified` — written and never walked.
- `verified (YYYY-MM-DD)` — walked on that date from the named documents. `; not driven: <what and why>` follows when a part could not be driven.
- `stale (YYYY-MM-DD): <what differs>` — a later run found the documents no longer match the task.

`npm test` runs a check (`src/cli/readme.test.ts`) that fails when an entry misses a field, carries an invalid status, or links to a file or heading that does not exist.

## Tasks

### T1 — Decide fit

- **Reader:** A developer who landed on the repository and has not used the tool.
- **Documents:** [README.md](../README.md)
- **Ends up able to:** Say what agent-system does, name three things they could do with it, and name two things it never does.
- **Status:** verified (2026-10-15)

### T2 — First run

- **Reader:** A developer with Node.js and `gh` installed.
- **Documents:** [README.md](../README.md#quick-start)
- **Ends up able to:** Install and build, run `init`, check readiness for one runtime, and see a dispatch refused for lack of an approval.
- **Status:** verified (2026-10-15)

### T3 — Agent setup

- **Reader:** A coding agent that a person has told to set the tool up, with the paste-ready prompt from the README as its only instruction.
- **Documents:** [README.md](../README.md#set-it-up-with-a-coding-agent), [docs/AGENT-SETUP.md](AGENT-SETUP.md)
- **Ends up able to:** Complete setup to the checkpoint in the runbook, report readiness per runtime, and stop at every step only the person can do.
- **Status:** verified (2026-10-15); not driven: the refused dispatch in step 8, because the walking agent's own tool blocked the command, as the guide allows

### T4 — Pick a first job

- **Reader:** A developer who wants one of: an approved task, CI repair, the ticket loop, the console, or the MCP server.
- **Documents:** [README.md](../README.md#what-you-can-do)
- **Ends up able to:** Find the exact next document or command for the chosen job.
- **Status:** verified (2026-10-15)

### T5 — Runtime prerequisites

- **Reader:** An operator who intends to dispatch to a particular runtime.
- **Documents:** [README.md](../README.md#what-each-runtime-needs), [docs/AGENT-SETUP.md](AGENT-SETUP.md)
- **Ends up able to:** Name what each of the four runtimes needs before it can dispatch, including the manifest-dev plugins and the Codex cloud skill check.
- **Status:** verified (2026-10-15); not driven: codex-cloud and claude-web readiness, because no environment id or cloud session exists here

### T6 — Loop platform

- **Reader:** An operator who wants the ticket loop to run on their machine.
- **Documents:** [README.md](../README.md#before-you-start)
- **Ends up able to:** Say whether `agentsys loop arm` works on their machine and what to run instead if it does not.
- **Status:** verified (2026-10-15)

### T7 — Visit the page

- **Reader:** A visitor who followed a link to the explainer page.
- **Documents:** [site/index.html](../site/index.html)
- **Ends up able to:** Say what the tool does, find the install commands, and copy them.
- **Status:** verified (2026-10-15)

### T8 — Safety check

- **Reader:** A developer who wants to know what the tool can and cannot do to their repositories.
- **Documents:** [README.md](../README.md#what-it-never-does), [site/index.html](../site/index.html)
- **Ends up able to:** State what the tool never does and what a fresh install does.
- **Status:** verified (2026-10-15)
