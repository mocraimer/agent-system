# Local control UI

The control UI is a local operator console over the coordinator and the loop it
runs. It is not a hosted dashboard and it does not expose a public HTTP service.

## Start it

From the system repository root, after building:

```sh
npm run build
node dist/cli/main.js ui --repo ~/src/larkspur
# or, after installing the package: agentsys ui --repo ~/src/larkspur
```

`--repo` names the store the console watches: the target repository's checkout,
whose `origin` is the GitHub repository. It is trusted startup configuration; the
browser never names a repository or a path. Without `--repo` the UI opens on
Advanced, the coordinator's own views, and the console views say how to start it.
`--store-file <file.json>` reads a fixture store from a file instead of GitHub,
for tests and design reviews; nothing it does reaches GitHub.

The server binds to `127.0.0.1` on a random port and prints a URL containing a
one-time bootstrap token. Open that URL in the same machine's browser. The token
is exchanged for a short-lived local session and removed from the address bar.
Do not share the URL.

The UI reads `AGENTSYS_STATE` when it is set, otherwise `.state` below the current
working directory. Repository paths used for dispatch must be inside the trusted
startup root, which is the current working directory when started by `agentsys ui`.

Set up the operator and runtime sessions in the CLI before starting the UI:

```sh
node dist/cli/main.js init --operator you@example.com
node dist/cli/main.js readiness
node dist/cli/main.js config --show
```

The UI does not expose `init` or configuration writes. It derives the configured
operator from trusted startup state; the browser cannot select an operator or pass
`--as`.

## The workspace views

The header separates the current operator state from loop activity, with the last
pass time and the Inbox count. **Needs you**, **Blocked**, and **Unknown** are not
an idle, empty queue. The decision workspace is the first view. Activity keeps loop and queued work
separate; the earlier Inbox, Steer, Inspect, and Advanced routes remain available.

### Board — decisions

The Board is a grouped decision queue beside the selected item's evidence and
next step. Find a title or number, or choose a group; select another decision
without navigating away. Merge decisions, proposals, assessments, blockers and
other decisions appear only when populated. On narrow screens the queue stacks
above the evidence; Back to queue returns focus to the selected row. The detail
sheet shows the reason, owner, snapshot age and current proposal, assessment or
review text when available. A missing proposal or assessment cannot be accepted; the safe close alternative
remains available. An assessment whose currentness is unknown is labelled as
such, not called approved. Accepted findings are not a clean review or permission
to merge.

Working, review-pending and other non-decision items live under Activity, linked
from the decision workspace. A failed read keeps the last snapshot with its age and
error, disables local decision actions, and offers a refresh. With no prior read,
the number of decisions is unknown, not zero.

Actions send the inspected decision token through the authenticated command
boundary. A changed head, fingerprint or unreadable store can refuse the action.
The refusal stays beside the selected evidence; refresh it before deciding again.
The legacy Inbox also obtains a fresh token before each action and disables an
auto grant when no assessment can be read. The browser does not decide whether
the refreshed item remains eligible; the server does.

### Activity

A separate read-only view of running, review-pending, queued and outside-loop
items, each with its current reason. It does not call idle work a human decision.
Select a row to open the full Inspect history.

### Inbox

Every Needs-you item, with what it waits for and its one action, and below them
the Ready-to-merge items. Each action calls one function of the console command
layer (`src/console/commands.ts`), which checks the configured operator first and
refuses an action the item does not offer:

| Action | What it does |
|---|---|
| Apply shaped | Adds the `shaped` label to the ticket. |
| Apply auto | Adds the `auto` label to the ticket. |
| Close as not planned | Closes the ticket as not planned (offered beside the two above). |
| Close as completed | Closes a claimed ticket whose pull request merged. |
| Release claim | Unassigns the people assigned to the ticket, handing it back to the loop. |
| Dismiss fault | Comments that you read it and closes the loop's fault issue. |
| Send answer | Posts your answer on an escalated ticket and removes `escalated`. |
| Merge now | Runs the loop's merge stage for that pull request, with the stage's own conditions: stop-line at `dev` or above, an independent review at the head that is clean or has findings explicitly accepted and pinned there by the operator, and `check-pr` ready. A fresh head requires fresh review and acceptance; the merge still needs its grant. |
| Open on GitHub | A link, for work the console cannot do — a clean pull request below its stop-line is merged by a person. |

GitHub writes go through `gh` on this machine under the operator's login, never
from the browser. An action the coordinator refuses shows the refusal text as the
coordinator worded it. Each action can carry an explicit verdict with a reason on
one of the item's scorecards; it is recorded after the action succeeds, through the
same command as `agentsys feedback`.

### Steer

- **Stop-lines and stage tiers**: the live value from the store configuration on
  the base branch, any value an open pull request proposes, and a field to propose
  a new one. Proposing commits the one table row on a branch of its own
  (`console/stop-line-<type>`, `console/tier-<stage>`) and opens a pull request
  against the base branch — or updates the one already open. The loop reads only
  merged policy, so the row shows *live* and *proposed* until a person merges it.
- **Loop limits**: read only, with proposals shown.
- **Stages**: pause or resume each stage. The next pass logs *stage paused by
  operator* for a paused stage and dispatches nothing from it.
- **Runs**: stop a run in flight — the runtime's process is signalled, the run's
  dispatch records how it ended, and the stop is recorded on its scorecard with
  your name — or redispatch a finished one: the same request, under the same
  authority, as a new run with a new id.

### Inspect

One item — from the Board's activity list, the Inbox, or by naming any ref of the
store, a merged pull request too: where it stands and why, current proposal,
assessment or review text with its currentness, scorecards with the tier and short
prompt digest, recorded attempts (including interrupted and unverified ones),
loaded build identity, available run evidence files, and the trust table for its
type of work — runs, independent
reviews, reviews, findings, fix rounds, escalations, merges, and the derived and
explicit verdict counts in separate columns, with the stop-line in force beside
them. The numbers are counts; there are no rates.

**Freeze as case** turns the item into an evaluation case: pick the kind and the
expected outcome, state the expectation in your words, and — for a reviewer case —
the words a finding must contain. The console pins the head, the base, the ticket
body's hash, the review marker, and the prompt and tier behind the run, writes the
case into a new `incidents-<n>` suite version, and freezes it.

### Advanced

The coordinator's earlier views, unchanged: Overview, Work (dispatch, recovery,
intake), Authority (approvals and grants), Safety (readiness, usage, policies,
ledger, versions), and Evidence (checks, run evidence, feedback).

## What it does not do

The UI does not merge into `main`, force-push, release, deploy production, manage
credentials, run arbitrary commands, or create authority from browser text. Its
only merge is the merge stage's, into `dev`. A policy change is always a pull
request. A disabled button is not a security check; the server and the command
layer re-check every request.

## Status and evidence

The UI uses the coordinator's exact outcome states. It shows elapsed time, not a
completion percentage. `remote-uncertain`, stale usage, held reservations, missing
evidence, and deferred checks remain visible and actionable.

Evidence is served only as bounded text from the selected run's evidence directory.
The client renders event, review, agent, and command text as text rather than HTML.
Unknown usage or cost is never displayed as zero. Evaluation views show raw counts,
not reliability percentages.

## Verification

The UI has isolated HTTP/security tests in the regular Node suite and real browser
journeys:

```sh
npm run typecheck
npm run lint
npm test
npx playwright install chromium   # once per machine
npm run test:ui
```

The browser tests use temporary state and never call a provider or GitHub.
`ui-tests/console.spec.ts` starts the real `agentsys ui --repo … --store-file …`
against a fixture repository and store, checks each view, and checks the board's
counts against the fact model. It also writes `board-populated.png`, `inbox.png`,
`board-nothing-to-do.png` and `board-stale.png` to `test-results/console-screens/`
at 1280×800. To regenerate the screenshots in `docs/console-screens/`:

```bash
npm run test:ui
cp test-results/console-screens/{board-populated,inbox,board-nothing-to-do,board-stale}.png docs/console-screens/
```

`ui-tests/console-journey.spec.ts` performs every inbox action and the merge through
the merge stage, pauses and resumes a stage, and stops and redispatches a run, with
fake adapters. `ui-tests/control-ui.spec.ts` drives the Advanced views as before.

## Session and restart behavior

The bootstrap token is valid once and is kept in server memory. The session expires
when the server's session lifetime ends or the process stops. Stopping the UI does
not cancel a vendor run. After restarting it, reload the UI and use the recovery
control before starting another attempt. Durable run, job, reservation, and evidence
records remain authoritative if the browser or UI process restarts; the last store
snapshot is kept too, so a restarted console shows it with its age while GitHub is
unreachable.
