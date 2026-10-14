import type { FeedbackVerdict, Scorecard } from '../eval/scorecard.js';
import { parseFixMarkers } from '../loop/markers.js';
import type { IssueFact, PullFact, StoreSnapshot } from './snapshot.js';

/**
 * Verdicts on the loop's work: what a person said explicitly, and what their
 * actions on the store already say.
 *
 * Merging a pull request, granting a proposal, or closing a ticket as not planned
 * is a judgement, and the operator makes it in GitHub whether or not they ever run
 * `agentsys feedback`. Those acts are read here as *derived* verdicts, each naming
 * the store event it came from. They are signal, not the operator's word: an
 * explicit verdict supersedes a derived one for its scorecard, the derived one is
 * kept, and every count keeps the two sources apart.
 */

export type VerdictSource = 'derived' | 'explicit';

/** The store event a derived verdict was read from. */
export interface StoreEvent {
  type: 'merged' | 'labeled' | 'edited' | 'closed' | 'fix-reply';
  /** What the event is on or about: `#661`, `comment 1234`. */
  id: string;
  actor: string;
  at: string;
}

/** A review's findings as the fix stage judged them. */
export interface FindingTally {
  accepted: number;
  rejected: number;
  outOfScope: number;
}

interface VerdictBase {
  cardId: string;
  /** The item the scorecard is about: `#123` or `PR #456`. */
  item: string;
  stage: string;
  workType: string;
  verdict: FeedbackVerdict;
  /** One line a person can check: `labeled auto by octocat 2026-09-13T17:49Z`. */
  detail: string;
  /** Set on a verdict an explicit one replaced; it is kept and still counted under its own source. */
  superseded?: boolean;
}

export interface DerivedVerdict extends VerdictBase {
  source: 'derived';
  /** Which row of the derivation table produced it. */
  rule: DerivationRule['id'];
  event: StoreEvent;
  findings?: FindingTally;
}

export interface ExplicitVerdict extends VerdictBase {
  source: 'explicit';
  by: string;
  reason: string;
  at: string;
}

export type VerdictRecord = DerivedVerdict | ExplicitVerdict;

/** What the derivation reads besides the scorecard: the snapshot and the store's own proposal marker. */
export interface DerivationContext {
  issue(number: number): IssueFact | undefined;
  pull(number: number): PullFact | undefined;
  /** Pull requests opened from a branch, open or not. */
  pullsFrom(branch: string): PullFact[];
  shapeMarker: string;
}

export function derivationContext(snapshot: StoreSnapshot, shapeMarker: string): DerivationContext {
  const issues = [...snapshot.issues, ...snapshot.referencedIssues];
  const pulls = [...snapshot.pulls, ...snapshot.referencedPulls];
  return {
    issue: (n) => issues.find((i) => i.number === n),
    pull: (n) => pulls.find((p) => p.number === n),
    pullsFrom: (branch) => pulls.filter((p) => p.headRefName === branch),
    shapeMarker,
  };
}

const numberIn = (item: string): number | undefined => {
  const m = /#(\d+)/.exec(item);
  return m ? Number(m[1]) : undefined;
};

const minute = (at: string): string => at.replace(/:\d\d(\.\d+)?Z$/, 'Z');

type Derived = Omit<DerivedVerdict, 'cardId' | 'item' | 'stage' | 'workType' | 'source' | 'rule'>;

export interface DerivationRule {
  id: 'merged' | 'granted-unchanged' | 'edited-before-grant' | 'closed-not-planned' | 'fix-replies';
  /** The stages whose scorecards this row judges. */
  stages: readonly string[];
  /** The row as the operator guide states it. */
  reads: string;
  derive(card: Scorecard, ctx: DerivationContext): Derived[];
}

/** The pull request a scorecard's work produced: its own item, or the one the sweep opened for its ticket. */
function pullOf(card: Scorecard, ctx: DerivationContext): PullFact | undefined {
  const loop = card.loop!;
  if (loop.item.startsWith('PR #')) return ctx.pull(numberIn(loop.item)!);
  const wrote = /^PR #(\d+)$/.exec(loop.wrote ?? '');
  if (wrote) return ctx.pull(Number(wrote[1]));
  const ticket = numberIn(loop.item);
  return ticket === undefined ? undefined : ctx.pullsFrom(`ticket/${ticket}`).find((p) => p.state === 'MERGED');
}

/** The first `shaped` or `auto` label applied after the proposal run, which is the grant. */
function grantAfter(issue: IssueFact, since: string): IssueFact['events'][number] | undefined {
  return issue.events.find((e) => e.type === 'labeled' && (e.label === 'shaped' || e.label === 'auto') && e.at >= since);
}

/**
 * The derivation table (ASM-3). One row per way the store records a judgement;
 * changing what an act means is changing its row.
 */
export const DERIVATION_RULES: readonly DerivationRule[] = [
  {
    id: 'merged',
    stages: ['sweep', 'fix'],
    reads: 'The pull request the work produced was merged: accepted.',
    derive: (card, ctx) => {
      const pr = pullOf(card, ctx);
      if (!pr || pr.state !== 'MERGED' || !pr.mergedAt) return [];
      const actor = pr.mergedBy ?? 'unknown';
      return [{
        verdict: 'accepted',
        detail: `merged #${pr.number} by ${actor} ${minute(pr.mergedAt)}`,
        event: { type: 'merged', id: `#${pr.number}`, actor, at: pr.mergedAt },
      }];
    },
  },
  {
    id: 'granted-unchanged',
    stages: ['shape'],
    reads: '`shaped` or `auto` applied after the proposal with no edit to the body in between: accepted.',
    derive: (card, ctx) => {
      const issue = ctx.issue(numberIn(card.loop!.item) ?? -1);
      const grant = issue ? grantAfter(issue, card.createdAt) : undefined;
      if (!issue || !grant) return [];
      if (issue.edits.some((e) => e.at >= card.createdAt && e.at <= grant.at)) return [];
      return [{
        verdict: 'accepted',
        detail: `labeled ${grant.label} by ${grant.actor} ${minute(grant.at)}`,
        event: { type: 'labeled', id: `#${issue.number}`, actor: grant.actor, at: grant.at },
      }];
    },
  },
  {
    id: 'edited-before-grant',
    stages: ['shape'],
    reads: 'The body was edited between the proposal and the grant: rework-needed.',
    derive: (card, ctx) => {
      const issue = ctx.issue(numberIn(card.loop!.item) ?? -1);
      const grant = issue ? grantAfter(issue, card.createdAt) : undefined;
      if (!issue || !grant) return [];
      const edit = issue.edits.find((e) => e.at >= card.createdAt && e.at <= grant.at);
      if (!edit) return [];
      return [{
        verdict: 'rework-needed',
        detail: `body edited between proposal and grant, by ${edit.editor} ${minute(edit.at)}; then labeled ${grant.label}`,
        event: { type: 'edited', id: `#${issue.number}`, actor: edit.editor, at: edit.at },
      }];
    },
  },
  {
    id: 'closed-not-planned',
    stages: ['shape'],
    reads: 'Closed as not planned, or labeled `wontfix`, after the proposal: rejected.',
    derive: (card, ctx) => {
      const issue = ctx.issue(numberIn(card.loop!.item) ?? -1);
      if (!issue) return [];
      const close = issue.closes.find((c) => c.reason === 'NOT_PLANNED' && c.at >= card.createdAt);
      if (close) {
        return [{
          verdict: 'rejected',
          detail: `closed not planned by ${close.actor} ${minute(close.at)}`,
          event: { type: 'closed', id: `#${issue.number}`, actor: close.actor, at: close.at },
        }];
      }
      const wontfix = issue.events.find((e) => e.type === 'labeled' && e.label === 'wontfix' && e.at >= card.createdAt);
      return wontfix ? [{
        verdict: 'rejected',
        detail: `labeled wontfix by ${wontfix.actor} ${minute(wontfix.at)}`,
        event: { type: 'labeled', id: `#${issue.number}`, actor: wontfix.actor, at: wontfix.at },
      }] : [];
    },
  },
  {
    id: 'fix-replies',
    stages: ['review'],
    reads: 'The fix stage\'s reply marks each finding [accepted], [rejected] or [out-of-scope]; all accepted: accepted, all rejected: rejected, a mix: rework-needed. The tally is kept.',
    derive: (card, ctx) => {
      const pr = ctx.pull(numberIn(card.loop!.item) ?? -1);
      const head = card.loop!.head?.toLowerCase();
      if (!pr || !head) return [];
      const out: Derived[] = [];
      for (const comment of pr.comments) {
        const marker = parseFixMarkers(comment.body)[0];
        if (!marker || !(head.startsWith(marker.from.toLowerCase()) || marker.from.toLowerCase().startsWith(head))) continue;
        const tally = tallyFindings(comment.body);
        const judged = tally.accepted + tally.rejected;
        if (judged === 0) continue;
        const verdict: FeedbackVerdict = tally.rejected === 0 ? 'accepted' : tally.accepted === 0 ? 'rejected' : 'rework-needed';
        out.push({
          verdict,
          findings: tally,
          detail: `fix round ${marker.round} replied: ${tally.accepted} finding(s) accepted, ${tally.rejected} rejected, ${tally.outOfScope} out of scope (comment ${comment.id}, ${minute(comment.createdAt)})`,
          event: { type: 'fix-reply', id: `comment ${comment.id}`, actor: comment.author, at: comment.createdAt },
        });
      }
      return out;
    },
  },
];

/** `1. [accepted] …` lines in a fix reply, as the fix prompt asks for them. */
export function tallyFindings(reply: string): FindingTally {
  const tally: FindingTally = { accepted: 0, rejected: 0, outOfScope: 0 };
  for (const m of reply.matchAll(/^\s*\d+\.\s*\*{0,2}\[(accepted|rejected|out-of-scope)\]/gim)) {
    const tag = m[1]!.toLowerCase();
    if (tag === 'accepted') tally.accepted++;
    else if (tag === 'rejected') tally.rejected++;
    else tally.outOfScope++;
  }
  return tally;
}

/**
 * Every verdict on the loop's scorecards: derived ones from the snapshot (none
 * when there is no fresh snapshot to read them from), explicit ones from the
 * cards. An explicit verdict marks the derived ones on its card superseded.
 */
export function verdictsFor(cards: Scorecard[], ctx: DerivationContext | undefined): VerdictRecord[] {
  const out: VerdictRecord[] = [];
  for (const card of cards) {
    if (!card.loop) continue;
    const base = { cardId: card.id, item: card.loop.item, stage: card.loop.stage, workType: card.loop.workType };
    const explicit = card.feedback && !card.feedback.isFixture ? card.feedback : undefined;
    if (ctx) {
      for (const rule of DERIVATION_RULES) {
        if (!rule.stages.includes(card.loop.stage)) continue;
        for (const d of rule.derive(card, ctx)) {
          out.push({ ...base, ...d, source: 'derived', rule: rule.id, ...(explicit ? { superseded: true } : {}) });
        }
      }
    }
    if (explicit) {
      out.push({ ...base, source: 'explicit', verdict: explicit.verdict, by: explicit.by, reason: explicit.reason, at: explicit.at, detail: `${explicit.verdict} by ${explicit.by}: ${explicit.reason}` });
    }
  }
  return out;
}

/** The verdict that stands for a scorecard: its explicit one, else its newest derived one. */
export function currentVerdict(records: VerdictRecord[], cardId: string): VerdictRecord | undefined {
  const mine = records.filter((r) => r.cardId === cardId);
  const explicit = mine.find((r) => r.source === 'explicit');
  if (explicit) return explicit;
  return mine.filter((r): r is DerivedVerdict => r.source === 'derived').sort((a, b) => a.event.at.localeCompare(b.event.at)).pop();
}

export type VerdictTally = Record<FeedbackVerdict, number>;

export interface VerdictCounts {
  derived: VerdictTally;
  explicit: VerdictTally;
}

const emptyTally = (): VerdictTally => ({ accepted: 0, 'rework-needed': 0, rejected: 0 });

/**
 * Count verdicts by source. There is deliberately no total across sources and no
 * rate: a merge is not the operator saying the work was good, and a handful of
 * either is not a reliability figure.
 */
export function countVerdicts(records: VerdictRecord[]): VerdictCounts {
  const counts: VerdictCounts = { derived: emptyTally(), explicit: emptyTally() };
  for (const r of records) counts[r.source][r.verdict]++;
  return counts;
}

const sum = (t: VerdictTally): number => t.accepted + t['rework-needed'] + t.rejected;

/** `derived: 2 (accepted 2, rework-needed 0, rejected 0), explicit: 1 (…)`. */
export function renderVerdictCounts(counts: VerdictCounts): string {
  const part = (source: VerdictSource): string => {
    const t = counts[source];
    return `${source}: ${sum(t)} (accepted ${t.accepted}, rework-needed ${t['rework-needed']}, rejected ${t.rejected})`;
  };
  return `${part('derived')}, ${part('explicit')}`;
}
