# Model and effort rungs

A dated reading of one published comparison, kept so a person choosing a tier can see what they are
trading away. It is **not** ground truth, and nothing consults it at dispatch time.

- **Source:** <https://aviramk.com/blog/which-model-at-which-effort/>
- **Taken:** 2026-10-01
- **Reachable:** Claude Fable 5.1, Claude Opus 5, Claude Opus 5.5, Claude Sonnet 5, Claude Sonnet 5.5, GPT-5.5, GPT-5.6 Luna, GPT-5.6 Sol, GPT-5.6 Terra, GPT-6 Astra, GPT-6 Luna, GPT-6.1 Sol
- **Refresh:** `npm run rungs:refresh` reports every rung whose score or cost has moved, **and every
  model family the source scores that this table does not track**, and exits non-zero when there is
  either. It never silently rewrites this file, and it never adds a family on its own — see the
  selection rule below.

## Current stage options — 2026-10-01

Each work stage of the ticket loop lists **one Claude option and one GPT option**, with no
fixed order between them, and each pass runs the one whose weekly room would lapse soonest. The
rows live in `tickets/store-config.md` ("Stage tiers"); this section records what they rest on.

| Stage | Claude option | GPT option |
|---|---|---|
| shape | `claude-opus-5-5` · xhigh | `gpt-6.1-sol` · max |
| assess, sweep, fix, check | `claude-sonnet-5-5` · high | `gpt-6.1-sol` · high |

Reviews keep the rule that a model of the other family reviews. `gpt-6.1-sol` · max is now the first
GPT reviewer of Claude-written pull requests, in place of `gpt-6-sol` · high; the other review rows
are unchanged, and GPT-written pull requests are still reviewed by `claude-opus-5-5` · high.

**What the page says about each choice.** The page's figures are from data dated 2026-09-29, and
`≈` appears where the page labels a figure as estimated:

| Choice | Figure | $ / figure task | Execute | $ / execute task |
|---|---:|---:|---:|---:|
| Claude Opus 5.5 · xhigh (shape) | ≈ 78.69 | ≈ $3.8649 | ≈ 66.24 | ≈ $5.4653 |
| GPT-6.1 Sol · max (shape, first GPT review) | 72.81 | $0.7603 | ≈ 63.66 | ≈ $1.4883 |
| Claude Sonnet 5.5 · high (assess, sweep, fix, check) | ≈ 68.73 | ≈ $1.2767 | ≈ 57.79 | ≈ $2.1749 |
| GPT-6.1 Sol · high (assess, sweep, fix, check) | 70.66 | $0.3103 | ≈ 61.41 | ≈ $0.8128 |
| GPT-6 Sol · high (the first GPT reviewer until 2026-10-01) | 63.71 | $0.2517 | ≈ 49.82 | ≈ $1.3083 |

Read them as bands. GPT-6.1 Sol · high scores at or above Sonnet 5.5 · high in both lanes, but its
execute figure is predicted and the two ranges overlap, so the page does not separate them. The page
also says GPT-6.1 Sol supersedes GPT-6 Sol, and at every effort the two share, in both lanes, its
rung scores above GPT-6 Sol's. Shape is planning work, which is the figure lane. Its GPT option runs
at max, GPT-6.1 Sol's highest measured figure (72.81 against 70.66 at high), and its Claude option at
xhigh.

**How a pass chooses.** An option's score is its weekly room, after the run's own bound, divided by
the hours until that window resets: the room that is being lost fastest runs first. Equal scores go
to the first row in the table, and an option whose reset time cannot be read scores as if its reset
were 168 hours away. The five-hour window still gates admission but does not rank. Each dispatch
writes one `choice` line to the pass log with every option's numbers, or the reason it could not
start.

**The 24-hour ramp.** Each subscription's weekly ceiling rises in a straight line from its base,
70% on both, to 100% across the final 24 hours before that window resets. The 5% margin stays, so
the loop itself stops at 95% at the reset. At 12 hours out the ceiling is 85%. It is set with
`agentsys policy --subscription <id> --ramp-hours 24` and turned off with `--ramp-hours 0`.

**Bounds.** The admission bounds are operator-set. Claude rows keep their earlier bounds except shape
at xhigh, which takes 6% five-hour and 2% weekly, because the page prices Opus 5.5 · xhigh at about
1.9 times Opus 5.5 · high per task ($3.8649 against $2.0622, both estimated). `pi-local` rows have no
five-hour bound, because Codex reports no five-hour window, and take the weekly bound of the Claude
row beside them. The `gpt-6.1-sol` · max rows take 2% weekly for shape and 3% for the first review row.

## Superseded: current model choices — 2026-09-22

*Superseded on 2026-10-01 by the section above for the loop's stage and review choices. Kept as the
record of that day.*

Use **Claude Opus 5.5** (`claude-opus-5-5`) for future Opus selections. Use
`gpt-6-sol` and `gpt-6-luna` for future Pi Sol/Luna selections. Keep each
selection's explicit effort and allowance; the Fable and GPT-6 Astra choices
are unchanged. The old scores and costs below do not measure these successors.

The local Claude adapter defaults to `claude-opus-5-5` at medium; the cloud adapter
defaults to that same fixed identifier at high, not the moving `opus` alias.
Explicit operator requests and approved tiers are not renamed. The loop reads its
stage and review tiers from the target's `tickets/store-config.md`, not these
adapter defaults. Changing that remote policy takes effect on the next pass;
coordinate its human merge with held dispatch, rather than treating it as a docs update.

The [official migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)
names the fixed identifier and makes effort explicit. These adapters invoke Claude
Code, not the Messages API: Claude Code owns thinking, tool choice and conversation
blocks. The coordinator does not add API thinking budgets or fallback models.
A local result can report billed model IDs, errors or refusals; a cloud acknowledgement
cannot confirm effective model or effort. Runtime support alone does not establish
account-specific availability.

**Everything below is the dated Opus 5 / GPT-5.6 comparison and decision record,
not a benchmark of Opus 5.5 or GPT-6 Sol/Luna.** Its scores, costs and observed sweep
runs remain attached to the models that produced them. No new paid benchmark or
local quality, latency or saving claim accompanies this selection change.

## What the source says about its own limits

Two statements from the page, quoted because they bound everything below:

> These measured component scores do not include benchmark error bars.

> 65% of score weight measured.

So a gap of a point or two between two rungs is not a result. The page declines to separate a
0.11-point gap elsewhere, calling it "Too close to GPT-6 Astra xhigh to distinguish with current
evidence", and describes its own admission rules as "screening choices, not confidence intervals".
Read a rung's position as a rough band, not a rank.

## The two lanes

The source scores each rung twice, and the orders differ. **Figure** is working out what to do —
planning, reading a problem, deciding. **Execute** is carrying out work already decided. A single
blended number would hide the thing most worth seeing: **GPT-5.6 Luna · max beats GPT-5.6 Sol ·
medium in the execute lane on both axes, and loses to it in the figure lane.**

The page also states a floor for each lane: below 60 points the figure lane "is not worth running",
and below 40 the execute lane is not.

| Model · effort | Figure | $ / figure task | Execute | $ / execute task |
|---|---:|---:|---:|---:|
| Claude Opus 5.5 · max | ≈ 80.29 | ≈ $9.2711 | ≈ 67.06 | ≈ $10.7800 |
| Claude Opus 5.5 · xhigh | ≈ 78.69 | ≈ $3.8649 | ≈ 66.24 | ≈ $5.4653 |
| Claude Fable 5.1 · max | 76.78 | $7.3967 | ≈ 62.08 | ≈ $11.1198 |
| Claude Sonnet 5.5 · max | ≈ 76.17 | ≈ $8.9186 | ≈ 68.73 | ≈ $10.5362 |
| Claude Opus 5.5 · high | ≈ 76.02 | ≈ $2.0622 | ≈ 64.18 | ≈ $3.3820 |
| Claude Fable 5.1 · xhigh | 75.44 | $5.8215 | ≈ 62.93 | ≈ $9.6512 |
| Claude Opus 5.5 · medium | ≈ 74.73 | ≈ $1.4995 | ≈ 61.76 | ≈ $2.7520 |
| Claude Fable 5.1 · high | 73.98 | $3.8722 | ≈ 60.88 | ≈ $6.6788 |
| Claude Opus 5 · max | 73.19 | $5.5767 | 61.13 | $12.3602 |
| Claude Opus 5 · xhigh | 73.05 | $4.5100 | 59.39 | $10.3722 |
| GPT-6.1 Sol · max | 72.81 | $0.7603 | ≈ 63.66 | ≈ $1.4883 |
| Claude Fable 5.1 · medium | 72.67 | $3.0227 | ≈ 57.62 | ≈ $5.1482 |
| GPT-6 Astra · max | 72.03 | $3.1886 | 65.46 | $6.6658 |
| Claude Sonnet 5.5 · xhigh | ≈ 71.87 | ≈ $2.9816 | ≈ 64.76 | ≈ $5.2713 |
| GPT-6 Astra · xhigh | 71.04 | $2.2801 | 65.66 | $4.3358 |
| GPT-6 Astra · high | 70.79 | $1.7279 | 63.12 | $3.4234 |
| Claude Opus 5 · high | 70.77 | $3.3502 | 58.66 | $7.4928 |
| GPT-6.1 Sol · high | 70.66 | $0.3103 | ≈ 61.41 | ≈ $0.8128 |
| GPT-6.1 Sol · xhigh | 70.37 | $0.3729 | ≈ 62.81 | ≈ $0.9600 |
| Claude Fable 5.1 · low | 70.19 | $2.4605 | ≈ 55.01 | ≈ $4.0604 |
| GPT-6 Astra · medium | 69.79 | $1.4740 | 60.97 | $3.1395 |
| GPT-6.1 Sol · medium | 68.84 | $0.1973 | ≈ 59.48 | ≈ $0.6403 |
| Claude Sonnet 5.5 · high | ≈ 68.73 | ≈ $1.2767 | ≈ 57.79 | ≈ $2.1749 |
| Claude Opus 5 · medium | 68.28 | $1.7986 | 52.61 | $4.8090 |
| Claude Opus 5.5 · low | ≈ 66.36 | ≈ $0.5241 | ≈ 50.20 | ≈ $1.5975 |
| GPT-6 Astra · low | 65.93 | $0.7207 | 54.68 | $1.6604 |
| GPT-5.6 Sol · max | 65.48 | $1.3607 | 57.48 | $6.6141 |
| Claude Sonnet 5.5 · medium | ≈ 64.67 | ≈ $0.5816 | ≈ 49.89 | ≈ $1.6701 |
| GPT-6.1 Sol · low | 64.03 | $0.1107 | ≈ 50.30 | ≈ $0.4494 |
| GPT-5.6 Sol · xhigh | 63.63 | $1.0537 | 50.49 | $3.3859 |
| Claude Opus 5 · low | 62.53 | $0.7551 | 44.18 | $2.6600 |
| GPT-5.6 Sol · high | 61.83 | $0.7420 | 48.20 | $2.3884 |
| Claude Sonnet 5.5 · low | ≈ 60.84 | ≈ $0.3491 | ≈ 44.62 | ≈ $1.4288 |
| GPT-5.6 Sol · medium | 58.94 | $0.4095 | 41.76 | $1.4701 |
| GPT-6 Luna · max | 58.36 | $0.0551 | ≈ 41.52 | ≈ $0.3074 |
| GPT-5.6 Luna · max | 55.96 | $0.1292 | 43.19 | $1.5332 |
| GPT-6 Luna · xhigh | 54.83 | $0.0281 | ≈ 36.86 | ≈ $0.2666 |
| GPT-5.6 Sol · low | 54.22 | $0.2424 | 28.59 | $0.7105 |
| GPT-5.6 Luna · xhigh | 53.70 | $0.0720 | 34.79 | $0.7374 |
| GPT-6 Luna · high | 52.79 | $0.0218 | ≈ 32.73 | ≈ $0.1888 |
| GPT-5.6 Luna · high | 51.29 | $0.0419 | 28.01 | $0.3613 |
| GPT-6 Luna · medium | 50.49 | $0.0130 | ≈ 27.33 | ≈ $0.1320 |
| GPT-5.6 Sol · none | 45.77 | $0.2520 | ≈ 14.89 | ≈ $0.7935 |
| GPT-5.6 Luna · medium | 44.66 | $0.0149 | 11.24 | $0.1012 |
| GPT-6 Luna · low | 42.68 | $0.0048 | ≈ 5.93 | ≈ $0.0380 |
| GPT-5.6 Luna · low | 39.54 | $0.0097 | 4.78 | $0.0365 |
| GPT-6 Luna · none | 33.01 | $0.0091 | ≈ 18.52 | ≈ $0.0960 |
| GPT-5.6 Luna · none | 28.88 | $0.0098 | ≈ 4.67 | ≈ $0.1804 |

Rows are the page's own order, by figure score. **`≈` means the source marked that figure estimated
rather than measured** — every one of Claude Fable 5.1's execute figures carries it, and none of the
others do. That is not a footnote here; it is what the tier choices below turn on.

**The selection rule: this table is curated, not a mirror of anything.** A family is tracked when
something here can actually dispatch to it *and* someone has decided it is worth choosing between.
Two sets qualify, because two different things run work: the GPT rungs the coordinator dispatches to
through `pi`, and the Claude rungs the unattended ticket sweep can be pointed at.

That is narrower than what `pi` offers. As of 2026-09-13 `pi --list-models` lists eight models —
`gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`,
`gpt-5.6-terra` and `gpt-6-astra` — and this table covers three of them. **`gpt-5.6-terra` is scored
by the source and reachable through `pi`, and is deliberately not tracked here**: nothing has been
decided about it. `npm run rungs:refresh` now names it rather than passing over it in silence, which
is the whole point — an untracked family should be a choice somebody made, not one nobody noticed.

Claude Sonnet 5 is absent for a different reason, and the reason this file used to give was wrong.
It said the source leaves *its rungs* `Unscored` and `Unpriced`. Four of them are — `low`, `medium`,
`high` and `xhigh` — but **`max` is fully scored: figure 60.32 at $5.8908, execute 37.46 at
$17.1738.** So there is something to choose from, and it is a bad choice. That execute score sits
below the source's own floor of 40, at nearly three times what Claude Opus 5 · high costs in the same
lane. One scored rung out of five is also too thin to pick an effort along.

The two GPT families the refresh still names on 2026-10-01 are untracked on purpose — nobody has
decided about them, and no stage or review row names either. GPT-5.6 Terra carries five scored rungs
and GPT-5.5 four, both reachable through `pi`. The 2026-10-01 reading added Claude Opus 5.5, Claude
Sonnet 5.5, GPT-6.1 Sol, and GPT-6 Luna to the families this table tracks, because the loop's stage
options and review ladder now name them; the older rows stay because the dated sections below cite
them.

## Historical operator decisions — 2026-09-13

These are rulings from the 2026-09-13 session, now superseded for future Opus and Pi Sol/Luna selections. They are decisions, not conclusions from the table,
and the table read alone would lead somewhere else.

- **GPT-5.6 Sol · medium is here to gather evidence, not because it is the execute choice.** In the
  execute lane Luna · max beats it on both axes — 42.50 against 41.19, at $1.3882 against $1.4065.
  In the figure lane Sol · medium is 0.83 points better at roughly three times the cost, and the
  source cannot say whether 0.83 points is real. Keeping Sol · medium as a configured tier is how our
  own scorecards accumulate under it, so the question gets settled by our runs rather than argued
  from a page that declines to answer it.
- **GPT-5.6 Luna · max takes execute work until our own runs say otherwise.** It is the cheapest rung
  that clears the page's own execute floor and is not dominated by anything below it.
- **All three models draw the same weekly window.** `pi --list-models` reports `gpt-6-astra`,
  `gpt-5.6-sol` and `gpt-5.6-luna` all on provider `openai-codex`, and Codex cloud shares that
  subscription id. Moving work down a rung lowers what a task spends; it does not spread load across
  pools, and it does not buy headroom when that one window is exhausted.

## Historical tier decisions — 2026-09-13

Set by the operator on 2026-09-13. These are decisions; the table is what they were checked against.

| Work | Tier | What the table says about it |
|---|---|---|
| Most work | **Claude Opus 5 · high** | execute 58.22 at $7.44, measured. Near the top of the execute lane without paying for max |
| The unattended ticket sweep | **Claude Opus 5 · medium** | execute 51.82 at $4.73, measured. Chosen on 2026-09-13 after the first three sweep runs measured $0.91, $1.51 and $1.12 each — real money, small money, and a reason to stop paying for the top rung on routine ticket work |
| Medium jobs | **Claude Opus 5 · xhigh**, or **Claude Fable 5.1 · medium** | Opus·xhigh buys 1.05 execute points over Opus·high for $2.92 more, measured. Fable·medium is cheaper than Opus·high on both lanes and scores higher on figure — but its execute figure is estimated |
| Planning, and reviewing merges into `main` | **Claude Fable 5.1** | this is the figure lane, and Fable's figure scores are **measured**. It leads every Opus rung there: 73.15 at high against Opus·high's 70.06, for 62 cents more |

The split is better founded than it may look from the headline numbers. Fable 5.1 outscores Opus 5
in both lanes, so "use the higher-scoring model everywhere" is the obvious reading — and it would
rest on evidence the source does not claim to have, because every Fable execute figure is estimated.
Putting Fable on planning and review and Opus on execution puts each model on the lane where its own
figures are measured. Whether that was the reasoning or not, it is where the evidence lands.

The effort for planning and review is not fixed. Within Fable 5.1 the figure lane is measured at
every rung, so more effort buys real points: medium 71.79, high 73.15, xhigh 74.86, max 76.29, at
$3.88 / $5.01 / $7.59 / $9.64. Pick by what the job is worth.

### Not every tier can run everywhere

**The fallback workflow's tier must be a Claude rung.** It runs in GitHub Actions through
`anthropics/claude-code-action@v1`, whose every authentication path is Claude —
`anthropic_api_key`, `claude_code_oauth_token`, `use_bedrock`, `use_vertex`, `use_foundry`. Naming
`gpt-5.6-luna` or `gpt-5.6-sol` there does not select those models; it asks a Claude runtime for a
model it has never heard of.

The GPT rungs are the coordinator's. `agentsys dispatch --runtime pi-local` reaches them through
`pi`, which is where Sol and Luna are actually available. So a tier is chosen from this one table,
but which half of it you may choose from depends on what is going to run the work.

Where a tier is set: every stage of the ticket loop — the sweep and the review ladder
included — takes its tier from the Stop-lines section of `tickets/store-config.md` in that
repository, which is also where the rows above are chosen from. The manual fallback workflow,
`.github/workflows/ticket-sweep.yml`, names its own. Any other coordinator dispatch takes its tier
from the approval (`agentsys approve … --model … --effort …`).

### What the cheapest rung costs

Worth recording, because the obvious optimisation is to keep moving down and the table alone does
not say where to stop. On points-per-dollar in the execute lane, GPT-5.6 Luna · max is the best rung
on the page — 42.50 points at $1.39, about 31 points per dollar, against Claude Opus 5 · medium's
11. It is also unavailable to the sweep, and 42.50 sits 2.5 points above the source's own floor of
40 on a page that publishes no error bars.

The measured figures that settle it are ours, not the page's: three real sweep runs cost $0.91,
$1.51 and $1.12. A rung that saves a fraction of a dollar per run and produces a repair a reviewer
has to send back costs more than it saves. Cheap tiers earn their place where a model plans and a
person executes; they are weakest on unattended execution, which is exactly what the sweep is.

## How our own evidence supersedes this

A `Scorecard` records `settings` — requested, resolved and observed model and effort — and groups by
`effectiveConfiguration`. Once several tiers carry real sample counts,
`agentsys scorecards --class <c>` compares them on work we actually do, which is worth more than any
published ranking of work we do not. The table is what to use while that evidence is thin.

A new approval can name the current tier: `agentsys approve … --model gpt-6-luna --effort max`. Existing approvals retain their original model. Effort names are
runtime-specific, so `max` here means what `pi` calls max and nothing more.
