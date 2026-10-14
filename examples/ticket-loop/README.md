# Example: running the ticket loop on a product repository

This example shows how one team runs agent-system against its product. Larkspur is made up: a
monorepo with an API in `api/`, a web app in `web/` and a browser extension in `extension/`. Its
team works on a `dev` branch and releases to `main`, and a GitHub Actions workflow named `Deploy`
ships `main` to production. The loop shapes Larkspur's tickets, works the granted ones into pull
requests, reviews and fixes those pull requests, and verifies each release after it deploys.

| Path | Goes where | What it is |
|---|---|---|
| `target-repo/tickets/store-config.md` | The product repository, on `dev` | The loop's whole policy: rungs, stop-lines, model tiers, limits, review ladder, and the coordinator protocol |
| `target-repo/scripts/agent-system/*.mjs` | The product repository, on `dev` | Stand-ins for the post-deploy checks the release-checks table runs |
| `operator/setup.sh` | Run on the coordinator's machine | The floor, one grant per loop stage, and a dry run |

## Before you start

- A built agent-system checkout (`npm install && npm run build`).
- A clone of the product repository on the coordinator's machine, with `origin` pointing at it on
  GitHub. This is the `REPO_PATH` below; the loop fetches its `dev` branch and works in worktrees
  of it.
- `gh` logged in as an account that can comment on, label and open pull requests in the product
  repository. The loop writes as this account.
- The agent CLIs for the runtimes your tiers name: `claude` for `claude-local`, `pi` for
  `pi-local`.
- The [manifest-dev](https://github.com/doodledood/manifest-dev) plugin installed for those CLIs.
  The loop's prompts start its `run-ticket`, `define`, `review-pr` and `check-pr` skills.
- In the product repository, the labels the store configuration names: `shaped`, `question`,
  `auto`, `escalated`, `HUMAN`, `effort`, one `effort:<slug>` per effort with one tracking issue
  carrying `effort` and that label, and the `type:` labels.

## Steps

1. **Put the policy in the product repository.** Copy `target-repo/` into the repository root and
   commit it to `dev`. Edit `tickets/store-config.md` to your values. Change at least these:
   - the repository name in the first paragraph
   - `status home`, the effort whose tracking issue gets the loop's status comment
   - the model names in the tier tables
   - the marker prefix, a short name for your product

   The loop reads the file from `origin/dev` on every pass, so a policy change is a commit there.

2. **Set up the coordinator.** From the agent-system checkout:

   ```
   OPERATOR=you@example.com REPO_PATH=~/src/larkspur bash examples/ticket-loop/operator/setup.sh
   ```

   It records you as the operator. It sets the floor, which makes integration pull requests target
   `dev` and makes the production cloud project read-only. It creates one standing grant for each
   loop stage and runtime, then runs a dry pass. Set `SLUG=owner/name` for your repository.

3. **Read the dry run.** Each stage lists its items with *dispatch*, *skip* or *blocked* and the
   reason. Nothing was written. A stage reported as blocked for want of a grant is a grant
   `setup.sh` did not create.

4. **Arm the loop.**

   ```
   node dist/cli/main.js loop arm --repo ~/src/larkspur --interval 900
   ```

   This installs a systemd user service that runs one pass every 15 minutes.
   `node dist/cli/main.js status --repo ~/src/larkspur` prints the last pass.
   `node dist/cli/main.js ui --repo ~/src/larkspur` opens the board.

5. **Grant work.** The loop drafts a shaped body for each new ticket as a comment. Apply `shaped`
   to accept it, and `auto` to let the loop work it. The loop applies neither.

6. **Verify a release.** After you merge the `dev` → `main` pull request and `Deploy` completes, the
   verify stage runs each row of *Release checks* and posts the results on the release pull request.
   The `web e2e` row runs in a worktree of the deployed commit that you prepare with its env files:

   ```
   node dist/cli/main.js loop --repo ~/src/larkspur --once --stage verify --release <pr> --e2e-worktree <dir>
   ```

## Making it yours

- **Queue rules.** By default the loop decides which tickets need shaping, which await a verdict,
  which are ready and what a claim is by the convention in the store configuration above. To decide
  differently, commit `scripts/agent-system/shape-candidates.mjs` and `auto-candidates.mjs` to
  `dev`. They then replace the built-in rules entirely. [OPERATING.md](../../docs/OPERATING.md#queue-rules)
  lists the exports they need.
- **Release checks.** Each row is one command. The deploy scope command runs first, and the
  `key=value` lines it writes to `$GITHUB_OUTPUT` become `{scope.<key>}` in the commands. Leave the
  *Release checks* table out and the verify stage does nothing.
- **Stop-lines.** Raising a type's stop-line lets the loop take that work further: 5 lets it merge
  into `dev` once you also grant `loop-merge` with `merge-dev`. Nothing lets it merge into `main`.
