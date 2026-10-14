import type { Scorecard } from '../eval/scorecard.js';
import type { LoopPolicy } from './policy.js';
import { resolveStopLine } from './policy.js';

/**
 * What the loop's own record says about each kind of work, stage by stage.
 *
 * Computed from scorecards only — the same records the coordinator writes for
 * every run it dispatches — so the numbers behind raising a stop-line are the
 * ones nobody could have typed in. Counts, never rates: a handful of runs is
 * not a reliability figure, and the report says how many there are.
 */
export interface TrustRow {
  workType: string;
  stage: string;
  /** Model runs, counting every attempt. */
  runs: number;
  /** Review stage: completed reviews by a model of a different family. */
  independentReviews: number;
  /** Review stage: completed reviews of any kind. */
  reviews: number;
  /** Review stage: mean findings per completed review, or null with none. */
  findingsPerReview: number | null;
  /** Review stage: findings across every completed review, the count the mean is made from. */
  findings: number;
  /** Fix stage: mean fix rounds for pull requests that reached a clean review, or null with none. */
  fixRoundsToClean: number | null;
  /** Fix stage: fix rounds summed over the pull requests that reached a clean review, and how many did. */
  fixRounds: number;
  pullsCleaned: number;
  escalations: number;
  mergesToDev: number;
  stopLine: number;
  stopLineSource: string;
}

export function trustReport(cards: Scorecard[], policy: LoopPolicy, repo: string): TrustRow[] {
  const loopCards = cards.filter((c) => c.repo === repo && (c.loop || c.workClass?.startsWith('loop-')))
    .map((c) => c.loop ? c : { ...c, loop: { stage: c.workClass.slice(5), item: c.taskId, workType: 'unknown' } });
  // Keyed by a JSON pair so no character a work type may contain can split it wrongly.
  const groups = new Map<string, Scorecard[]>();
  for (const card of loopCards) {
    const key = JSON.stringify([card.loop!.workType, card.loop!.stage]);
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }

  // Rounds to clean are per pull request: the highest fix round before a review
  // at a later head reported no findings.
  const cleanRounds = new Map<string, number[]>();
  const byItem = new Map<string, Scorecard[]>();
  for (const card of loopCards) {
    if (card.loop!.stage !== 'fix' && card.loop!.stage !== 'review') continue;
    byItem.set(card.loop!.item, [...(byItem.get(card.loop!.item) ?? []), card]);
  }
  for (const [, itemCards] of byItem) {
    const sorted = [...itemCards].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let rounds = 0;
    for (const card of sorted) {
      if (card.loop!.stage === 'fix') rounds = Math.max(rounds, card.loop!.round ?? 0);
      else if (card.loop!.findings === 0 && rounds > 0) {
        const workType = card.loop!.workType;
        cleanRounds.set(workType, [...(cleanRounds.get(workType) ?? []), rounds]);
        rounds = 0;
      }
    }
  }

  const rows: TrustRow[] = [];
  for (const [key, group] of groups) {
    const [workType, stage] = JSON.parse(key) as [string, string];
    const reviews = group.flatMap((c) => c.reviews ?? []);
    const independent = reviews.filter((r) => r.reviewer.relationship === 'independent' && r.reviewer.independent);
    const findings = reviews.reduce((sum, r) => sum + r.findingCount, 0);
    const rounds = stage === 'fix' ? cleanRounds.get(workType) ?? [] : [];
    const stop = resolveStopLine(policy, workType === 'untyped' || workType === 'tracking' ? [] : [`type:${workType}`]);
    rows.push({
      workType,
      stage,
      runs: group.reduce((sum, c) => sum + c.runIds.length, 0),
      independentReviews: independent.length,
      reviews: reviews.length,
      findingsPerReview: reviews.length > 0 ? findings / reviews.length : null,
      findings,
      fixRoundsToClean: rounds.length > 0 ? rounds.reduce((a, b) => a + b, 0) / rounds.length : null,
      fixRounds: rounds.reduce((a, b) => a + b, 0),
      pullsCleaned: rounds.length,
      escalations: group.filter((c) => c.loop!.escalated === true).length,
      mergesToDev: group.filter((c) => c.loop!.merged !== undefined).length,
      stopLine: stop.rung,
      stopLineSource: stop.line,
    });
  }
  return rows.sort((a, b) => a.workType.localeCompare(b.workType) || a.stage.localeCompare(b.stage));
}

export function renderTrust(rows: TrustRow[]): string {
  if (rows.length === 0) return 'No scorecard carries a loop record for this repository yet.';
  const fmt = (n: number | null): string => (n === null ? '-' : n.toFixed(2));
  const out = [
    'Work type   Stage     Runs  Indep.rev  Reviews  Findings/rev  Fix rounds→clean  Escalations  Merges→dev  Stop-line',
  ];
  for (const r of rows) {
    out.push([
      r.workType.padEnd(11), r.stage.padEnd(9), String(r.runs).padStart(4), String(r.independentReviews).padStart(10),
      String(r.reviews).padStart(8), fmt(r.findingsPerReview).padStart(13), fmt(r.fixRoundsToClean).padStart(17),
      String(r.escalations).padStart(12), String(r.mergesToDev).padStart(11), `  ${r.stopLine}`,
    ].join(' '));
  }
  out.push('');
  out.push('Stop-lines in force:');
  for (const [workType, source] of new Map(rows.map((r) => [r.workType, r.stopLineSource]))) out.push(`  ${workType}: ${source}`);
  out.push('');
  out.push(`${rows.reduce((s, r) => s + r.runs, 0)} run(s) in total. Counts from .state/scorecards only; a small sample is not a reliability figure.`);
  return out.join('\n');
}
