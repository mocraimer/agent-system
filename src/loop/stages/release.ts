import { short, ticketOf } from '../context.js';
import type { PullRequest } from '../github.js';
import { resolveStopLine, rung } from '../policy.js';
import type { Item, PassContext, StagePlan } from '../types.js';

/**
 * Rung 6: open the base → release-branch pull request when the store's release
 * rule says one is due, or refresh the body of the one already open — and stop.
 *
 * This stage creates or edits one pull request and does nothing else to the
 * release branch. It never merges, never runs a release script, and never pushes.
 * The body is written from GitHub and git output, not by a model.
 */
export async function planRelease(ctx: PassContext): Promise<StagePlan> {
  const stageRung = rung(ctx.policy, 'release');
  const plan: StagePlan = { stage: 'release', rung: stageRung, items: [], notes: [], faults: [] };
  const due = await releaseDue(ctx, stageRung.number);
  plan.notes.push(
    `release: rule — due when a ticket whose pull request merged into ${ctx.base} since the last release has a stop-line at rung ${stageRung.number} or above, and every workflow run on the ${ctx.base} head succeeded (${stageRung.line})`,
    ...due.lines,
  );

  const releaseBranch = ctx.policy.protocol.releaseBranch.value;
  const [open] = await ctx.store.openPulls(releaseBranch, ctx.base);
  const ref = open ? `PR #${open.number} (${ctx.base} → ${releaseBranch})` : `${ctx.base} → ${releaseBranch}`;
  if (!due.due) {
    plan.items.push({ ref, decision: { kind: 'skip', reason: due.reason } });
    return plan;
  }
  const item: Item = {
    ref,
    decision: { kind: 'dispatch', detail: open ? `update the open release pull request's body (${due.reason})` : `open the release pull request (${due.reason})` },
    act: async () => {
      const body = await releaseBody(ctx, due.merged);
      if (open) {
        await ctx.store.updatePullBody(open.number, body);
        return { produced: true, summary: `release PR #${open.number} body updated; it stays open for a person to merge` };
      }
      const number = await ctx.store.createPull({ base: releaseBranch, head: ctx.base, title: `Release: ${ctx.base} → ${releaseBranch} (${ctx.startedAt.toISOString().slice(0, 10)})`, body });
      return { produced: true, summary: `release PR #${number} opened against ${releaseBranch}; it stays open for a person to merge` };
    },
  };
  plan.items.push(item);
  return plan;
}

interface MergedTicket {
  pr: PullRequest;
  ticket: number;
  stopLine: number;
  line: string;
}

/**
 * The release rule, quoted from the store configuration: due when a ticket whose
 * pull request merged into the base branch since the last release has a stop-line
 * at the release rung or above, and every workflow run on the base head succeeded.
 */
async function releaseDue(ctx: PassContext, releaseRung: number): Promise<{ due: boolean; reason: string; merged: MergedTicket[]; lines: string[] }> {
  const lines: string[] = [];
  const releases = (await ctx.store.mergedPulls(ctx.policy.protocol.releaseBranch.value, ctx.base)).filter((p) => p.mergedAt);
  const last = releases.sort((a, b) => Date.parse(b.mergedAt!) - Date.parse(a.mergedAt!))[0];
  const since = last?.mergedAt ? Date.parse(last.mergedAt) : 0;
  lines.push(`release: last release ${last ? `PR #${last.number} merged ${last.mergedAt}` : 'none found'}`);

  const merged: MergedTicket[] = [];
  for (const pr of await ctx.store.mergedPulls(ctx.base)) {
    const ticket = ticketOf(pr);
    if (ticket === undefined || !pr.mergedAt || Date.parse(pr.mergedAt) <= since) continue;
    const issue = await ctx.issue(ticket);
    const stop = resolveStopLine(ctx.policy, issue?.labels ?? []);
    merged.push({ pr, ticket, stopLine: stop.rung, line: stop.line });
    lines.push(`release: #${ticket} via PR #${pr.number} merged ${pr.mergedAt}, stop-line ${stop.rung} — ${stop.line}`);
  }
  const reaching = merged.filter((m) => m.stopLine >= releaseRung);
  if (merged.length === 0) return { due: false, reason: 'no ticket pull request merged since the last release', merged, lines };
  if (reaching.length === 0) {
    return { due: false, reason: `no ticket merged since the last release has stop-line ≥ ${releaseRung}`, merged, lines };
  }

  const runs = await ctx.store.runsForCommit(ctx.base, ctx.baseSha);
  const failing = runs.filter((r) => r.status !== 'completed' || !['success', 'skipped', 'neutral'].includes(r.conclusion ?? ''));
  lines.push(`release: ${runs.length} workflow run(s) on ${ctx.base} ${short(ctx.baseSha)}: ${runs.map((r) => `${r.workflow}=${r.conclusion ?? r.status}`).join(', ') || 'none'}`);
  if (runs.length === 0 || failing.length > 0) {
    return { due: false, reason: `${ctx.base} CI is not green at ${short(ctx.baseSha)}${failing.length ? ` (${failing.map((r) => r.workflow).join(', ')})` : ' (no runs recorded)'}`, merged, lines };
  }
  return { due: true, reason: `${reaching.map((m) => `#${m.ticket}`).join(', ')} merged with stop-line ≥ ${releaseRung}`, merged, lines };
}

async function releaseBody(ctx: PassContext, merged: MergedTicket[]): Promise<string> {
  const releaseBranch = ctx.policy.protocol.releaseBranch.value;
  await ctx.repo.fetch([releaseBranch, ctx.base]);
  const commits = await ctx.repo.log(`origin/${releaseBranch}`, `origin/${ctx.base}`);
  const skipCi = commits.filter((c) => /\[skip ci\]|\[ci skip\]/i.test(c.message));
  return [
    `Opened by the coordinator's loop in pass ${ctx.passId}. It opens this pull request and stops: a person reviews and merges it.`,
    '',
    `## Ticket pull requests merged into \`${ctx.base}\` since the last release`,
    '',
    ...merged.map((m) => `- #${m.ticket} — PR #${m.pr.number} ${m.pr.title} (merged ${m.pr.mergedAt}; stop-line ${m.stopLine})`),
    '',
    '## `[skip ci]` check',
    '',
    `Command: \`git log --format=%H%x00%B origin/${releaseBranch}..origin/${ctx.base}\` in the loop's fetch of ${ctx.slug}, ${ctx.base} at ${ctx.baseSha}.`,
    skipCi.length === 0
      ? `None of the ${commits.length} commit(s) between ${releaseBranch} and ${ctx.base} carries \`[skip ci]\` or \`[ci skip]\`, so a squash release will not skip CI.`
      : `These commits carry a skip marker and would make a squash release skip every workflow, the deploy included — reword them before merging:\n${skipCi.map((c) => `- ${c.sha}`).join('\n')}`,
    '',
  ].join('\n');
}
