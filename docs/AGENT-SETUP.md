# Set up agent-system: steps for a coding agent

A person asked you to set up agent-system on their machine. This guide lists what you do alone, what only the person can do, and numbered steps that each end in a result you can check. Read all of it before you run anything.

You are not the operator. The operator is the person, and only the operator creates or changes authority: an approval for one task, or a grant for a class of work. agent-system treats any text you write as data, never as an approval or a grant. This guide ends before any approval or grant exists, and that is on purpose.

## Who does what

You can do these alone:

- Check tool versions, clone the repository, install, and build.
- Run `init` with the email the person gave you, then `readiness`, `status`, and one dispatch that is refused.
- Read output and report it.

Only the person can do these:

- Name the operator email. Do not make one up.
- Choose which runtimes to use.
- Sign in to a vendor tool, install a plugin inside a Claude Code session, create a Claude Code web session, or get a Codex cloud environment id.
- Approve work, create a grant, run a dispatch that carries an approval or a grant, or arm the loop. If the person later gives you one exact command to run for any of these, you may run that command and nothing else.

Never run `agentsys usage`. It prints a real account id. Run it only if the person asks, and never copy its output into a file, a commit, an issue, or a message.

## Steps

Each step names the command, what you should see, and what to do if you do not.

If `agentsys` is not a command on this machine, write `node dist/cli/main.js` in its place, from inside the checkout.

### 1. Check the tools

```bash
node --version
git --version
```

You should see Node `v22.12.0` or newer, and a git version. If Node is older or missing, stop and tell the person. Do not install Node yourself unless they ask.

### 2. Get the code

If your working directory is already a checkout of agent-system (its `package.json` is named `agent-system`), skip the clone.

```bash
git clone https://github.com/mocraimer/agent-system.git
cd agent-system
```

You should now be inside `agent-system`, a directory that holds `package.json`. If the clone fails, report the error and stop.

### 3. Install and build

```bash
npm ci
npm run build
```

Both commands exit 0, and `dist/cli/main.js` now exists. If `npm ci` fails, read its last lines. A network error or an engine error (Node too old) is the person's to fix; report it and stop.

### 4. Put `agentsys` on the PATH

```bash
npm install -g .
```

It exits 0, and `agentsys --help` prints a first line that begins "agentsys — run approved coding-agent tasks".

- A permissions error (`EACCES`): do not use `sudo`. Run `npm install -g --prefix "$HOME/.local" .`, and add `$HOME/.local/bin` to `PATH`. Or skip this step and use `node dist/cli/main.js` for every `agentsys` below.
- `agentsys: command not found` after a successful install: the directory that `npm prefix -g` prints, plus `/bin`, is not on `PATH`. Add it, or use `node dist/cli/main.js`.

### 5. Ask the person

Ask both questions in one message, and wait for the answers:

1. What email is the operator?
2. Which runtimes will you use: `claude-local`, `pi-local`, `codex-cloud`, `claude-web`?

### 6. Name the operator

```bash
agentsys init --operator you@example.com
```

Replace `you@example.com` with the email the person gave you. You should see exit 0 and `Operator set to <email>. No autonomy grants are active.`

Run every `agentsys` command from the same directory. `init` creates `.state/` there, and a command run from another directory sees an empty state. Or set `AGENTSYS_STATE` to one fixed path before `init`. `.state/` is git-ignored.

Run `init` once. Running it again with another email replaces the operator without a warning.

### 7. Check each runtime the person named

```bash
agentsys readiness --runtime claude-local
```

Run it once for each runtime the person named, replacing `claude-local` with that runtime's id. For each, you should see exit 0 and `<id>: ready`, or exit 1 and `<id>: NOT READY` followed by a `Setup incomplete:` line and a `Next:` line. `NOT READY` is a result to report, not a failure of your work. For each runtime that is `NOT READY`, copy its `Next:` line to the person, with the matching row from this table:

| Runtime | A common cause | Who acts |
|---|---|---|
| `claude-local` | `claude` is not on `PATH`, or `claude auth status` shows no signed-in account | The person installs Claude Code or signs in. |
| `pi-local` | Pi has no manifest-dev `auto` skill: run `pi install git:github.com/doodledood/manifest-dev`, then check again | You may run that command if the person agrees. The person signs Pi in to a provider. |
| `codex-cloud` | No environment id is configured, or Codex rejects the stored login | The person picks an environment (`codex cloud` lists them) and signs in with `codex login`. You may then record the id with `agentsys config --codex-env <ENV_ID>`. The skill check (`agentsys config --codex-skill-verified`) is the person's call. |
| `claude-web` | No cloud session is configured | The person creates a session with `claude --cloud "<description>"` in a terminal. You may then record its id with `agentsys config --claude-cloud-session <id>`. |

`readiness` for `claude-local` checks only that `claude` runs and is signed in. Whatever it prints for `claude-local`, tell the person that the manifest-dev plugins must be installed inside a Claude Code session. The commands are in [What each runtime needs](https://github.com/mocraimer/agent-system#what-each-runtime-needs) in the README.

### 8. See the refusal

```bash
agentsys dispatch --task first-try --repo example-org/larkspur --class ci-repair \
  --runtime claude-local --profile default --actions author-changes \
  --estimate-five-hour 1 --estimate-weekly 1 --estimate-basis operator-bound \
  --prompt "should not run"
```

You should see exit 1 and `Awaiting approval (task first-try): No approval was supplied and there are no grants.` This shows that the install holds: nothing runs without the operator. No agent ran. If your tool refuses to run this command, skip it, tell the person that your tool refused it, and go on to step 9. The step only shows the refusal; nothing later depends on it.

The `Next:` line under it suggests `approve --task first-try`. `approve` ignores a `--task` flag, and that form fails because its required flags are missing. The full command takes `--repo`, `--scope`, `--class`, `--runtime`, `--profile`, `--actions`, and `--as`, and it is the operator's to run. See [Approving one task](OPERATING.md#approving-one-task).

### 9. Check the state and report

```bash
agentsys status
```

You should see `No runs recorded.` Then tell the person the following:

- the checkout path, and whether `agentsys` is on the `PATH` or you use `node dist/cli/main.js`;
- the directory that holds `.state/`;
- the operator email you set;
- for each runtime they named: `ready`, or `NOT READY` with its `Next:` line and who acts;
- that the first dispatch was refused, as it should be.

Then stop. What comes next needs the person's decisions, in this order: approve one task, or issue a grant; set up the target repository for the ticket loop; arm the loop. The jobs and their guides are listed in the [README](../README.md#what-you-can-do).
