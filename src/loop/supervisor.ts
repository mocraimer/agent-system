import { createHash } from 'node:crypto';
import { STATUS_MARKER, parseFaultMarker, renderFaultMarker } from './markers.js';
import type { Store } from './github.js';
import type { Fault, PassStage, StageName, StagePlan } from './types.js';

export type Classification = 'idle-empty' | 'waiting' | 'blocked' | 'progress' | 'stalled' | 'breach';

export interface StageCounts {
  /** Items the stage could act on this pass: dispatched or blocked. */
  queue: number;
  dispatched: number;
  produced: number;
  blocked: number;
  /** Items skipped with a reason — waiting on a person, a rule, or the next pass. */
  waiting: number;
}

export interface ItemReport {
  ref: string;
  stopLine?: number;
  stopLineSource?: string;
  decision: 'dispatch' | 'skip' | 'blocked';
  reason: string;
  result?: string;
  produced?: boolean;
  /** A dispatch refused by readiness or authority after planning. */
  blocked?: string;
}

export interface StageReport {
  stage: PassStage;
  rung: string;
  counts: StageCounts;
  items: ItemReport[];
  notes: string[];
}

export interface PassReport {
  passId: string;
  repo: string;
  dryRun: boolean;
  startedAt: string;
  endedAt: string;
  classification: Classification;
  /** Why the pass got its classification, in one line. */
  because: string;
  stages: StageReport[];
  faults: Fault[];
}

export interface FaultRecord {
  fingerprint: string;
  issue: number;
  title: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  /** Consecutive complete passes where this fault was not seen. Cleared when the fault reappears. */
  consecutiveAbsent?: number;
}

/** What the loop remembers between passes, kept in its state directory. */
export interface LoopState {
  repo: string;
  passes: number;
  /** Consecutive passes each stage had work and produced nothing. */
  streaks: Partial<Record<PassStage, number>>;
  faults: Record<string, FaultRecord>;
  lastPass?: PassReport;
  /** When the improve stage last ran for real. */
  lastImprove?: string;
  /** The Needs-you refs the last pass saw, to tell a transition from a wait that was already known. */
  needsYou?: string[];
}

export function emptyState(repo: string): LoopState {
  return { repo, passes: 0, streaks: {}, faults: {} };
}

export function countStage(plan: StagePlan): StageCounts {
  const counts: StageCounts = { queue: 0, dispatched: 0, produced: 0, blocked: 0, waiting: 0 };
  for (const item of plan.items) {
    if (item.decision.kind === 'skip') { counts.waiting++; continue; }
    counts.queue++;
    if (item.decision.kind === 'blocked' || item.result?.blocked) counts.blocked++;
    else counts.dispatched++;
    if (item.result?.produced) counts.produced++;
  }
  return counts;
}

export function stageReport(plan: StagePlan): StageReport {
  return {
    stage: plan.stage,
    rung: plan.rung ? `${plan.rung.number} ${plan.rung.name}` : '-',
    counts: countStage(plan),
    items: plan.items.map((item) => ({
      ref: item.ref,
      ...(item.stopLine ? { stopLine: item.stopLine.rung, stopLineSource: item.stopLine.line } : {}),
      decision: item.decision.kind,
      reason: item.decision.kind === 'dispatch' ? item.decision.detail : item.decision.reason,
      ...(item.result ? { result: item.result.summary, produced: item.result.produced, ...(item.result.blocked ? { blocked: item.result.blocked } : {}) } : {}),
    })),
    notes: plan.notes,
  };
}

/**
 * Advance each stage's streak and classify the pass.
 *
 * A breach outranks everything: something ran that the policy forbids. A stall
 * is a stage that has had work for `stallAfter` passes running and produced
 * nothing. A technical blocker or read error is blocked; unfinished attempts
 * and human waits are waiting. Only produced work is progress, and a pass with
 * no items or faults is idle-empty.
 */
export function classify(
  stages: StageReport[], faults: Fault[], previous: LoopState['streaks'], stallAfter: number, dryRun = false,
): { classification: Classification; because: string; streaks: LoopState['streaks']; stalls: Fault[] } {
  const streaks: LoopState['streaks'] = { ...previous };
  const stalls: Fault[] = [];
  for (const s of stages) {
    const stuck = s.counts.queue > 0 && s.counts.produced === 0;
    streaks[s.stage] = stuck ? (previous[s.stage] ?? 0) + 1 : 0;
    if (stuck && streaks[s.stage]! >= stallAfter) {
      const why = s.items.filter((i) => i.decision !== 'skip').map((i) => `${i.ref}: ${i.result ?? i.reason}`).join('; ');
      stalls.push({
        stage: s.stage, kind: 'stalled', subject: `${s.stage} stage`,
        detail: `${s.counts.queue} item(s) waited ${streaks[s.stage]} consecutive passes with nothing produced`,
        evidence: why,
      });
    }
  }
  const breaches = faults.filter((f) => f.kind === 'breach');
  if (breaches.length > 0) {
    return { classification: 'breach', because: breaches.map((b) => `${b.subject}: ${b.detail}`).join('; '), streaks, stalls };
  }
  if (stalls.length > 0) {
    return { classification: 'stalled', because: stalls.map((s) => `${s.subject} ${s.detail}`).join('; '), streaks, stalls };
  }
  const blocked = stages.flatMap((s) => s.items.filter((i) => i.decision === 'blocked' || i.blocked !== undefined).map((i) => `${s.stage} ${i.ref}: ${i.result ?? i.reason}`));
  blocked.push(...faults.filter((f) => f.kind === 'error').map((f) => `${f.stage} ${f.subject}: ${f.detail}`));
  if (blocked.length > 0) return { classification: 'blocked', because: blocked.join('; '), streaks, stalls };
  const worked = stages.filter((s) => s.counts.queue > 0);
  if (worked.some((s) => s.counts.produced > 0)) {
    return {
      classification: 'progress',
      because: dryRun
        ? `dry run — would dispatch ${worked.map((s) => `${s.stage} ${s.counts.dispatched}`).join('; ')}`
        : worked.map((s) => `${s.stage} ${s.counts.produced}/${s.counts.queue} produced`).join(', '),
      streaks,
      stalls,
    };
  }
  const waiting = stages.map((s) => ({ ...s, items: s.items.filter((i) => !/^assessment current\b|^no (merged release pull request|ticket .*since the last release|ticket in this release)/.test(i.reason)) })).filter((s) => s.items.length > 0);
  if (waiting.length > 0) return { classification: 'waiting', because: waiting.map((s) => `${s.stage}: ${s.items.map((i) => `${i.ref} ${i.result ?? i.reason}`).join('; ')}`).join('; '), streaks, stalls };
  return { classification: 'idle-empty', because: 'every stage\'s queue was empty', streaks, stalls };
}

export function faultFingerprint(fault: Pick<Fault, 'stage' | 'kind' | 'subject'>): string {
  return createHash('sha256').update(`${fault.stage}\n${fault.kind}\n${fault.subject}`).digest('hex').slice(0, 32);
}

export const faultTitle = (fault: Fault): string => `[loop] ${fault.stage} ${fault.kind}: ${fault.subject}`;

function faultBody(fault: Fault, fingerprint: string, record: { firstSeen: string; lastSeen: string; count: number }, passId: string): string {
  return [
    renderFaultMarker(fingerprint),
    `The coordinator's loop found a **${fault.kind}** in its ${fault.stage} stage.`,
    '',
    `- Item: ${fault.subject}`,
    `- What: ${fault.detail}`,
    `- First seen: ${record.firstSeen}`,
    `- Last seen: ${record.lastSeen}, pass ${passId}`,
    `- Seen in ${record.count} pass(es)`,
    '',
    'Evidence:',
    '',
    '```',
    fault.evidence,
    '```',
    '',
    'The loop updates this issue while the fault recurs and opens no second one for it. It closes this issue automatically after 2 consecutive complete passes in which the fault is absent.',
  ].join('\n');
}

/**
 * One issue per fault fingerprint. A fault already on record updates its issue;
 * one whose issue a person closed is a new occurrence and gets a new issue.
 *
 * When `isCompletePass` is true (neither dry-run nor stage-restricted), faults absent
 * from this pass have their `consecutiveAbsent` count incremented. After 2 consecutive
 * complete passes without the fault, the loop closes its issue with one closing comment.
 */
export async function reportFaults(
  store: Store, state: LoopState, faults: Fault[], passId: string, now: string, labels: string[], isCompletePass = false,
): Promise<string[]> {
  const log: string[] = [];
  const seen = new Set<string>();
  for (const fault of faults) {
    const fingerprint = faultFingerprint(fault);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const known = state.faults[fingerprint];
    if (known) {
      const issue = await store.issue(known.issue);
      if (issue && issue.state.toUpperCase() === 'OPEN' && parseFaultMarker(issue.body) === fingerprint) {
        const next: FaultRecord = { ...known, lastSeen: now, count: known.count + 1, consecutiveAbsent: 0 };
        await store.updateIssueBody(known.issue, faultBody(fault, fingerprint, next, passId));
        state.faults[fingerprint] = next;
        log.push(`fault: updated #${known.issue} (${faultTitle(fault)}), seen ${next.count} time(s)`);
        continue;
      }
    }
    const record: FaultRecord = { fingerprint, issue: 0, title: faultTitle(fault), firstSeen: now, lastSeen: now, count: 1, consecutiveAbsent: 0 };
    const issueNum = await store.createIssue({ title: faultTitle(fault), body: faultBody(fault, fingerprint, record, passId), labels });
    record.issue = issueNum;
    state.faults[fingerprint] = record;
    log.push(`fault: opened #${issueNum} (${faultTitle(fault)})`);
  }

  // Close issues for faults that have been absent from consecutive complete passes.
  if (isCompletePass) {
    for (const [fingerprint, record] of Object.entries(state.faults)) {
      if (seen.has(fingerprint)) continue; // fault was present this pass; already handled above
      const absent = (record.consecutiveAbsent ?? 0) + 1;
      if (absent >= 2) {
        const issue = await store.issue(record.issue);
        if (issue && issue.state.toUpperCase() === 'OPEN' && parseFaultMarker(issue.body) === fingerprint) {
          await store.createComment(record.issue, [
            renderFaultMarker(fingerprint),
            `This fault has not appeared in the last ${absent} consecutive complete passes and is considered cleared.`,
            `Last seen: ${record.lastSeen}.`,
            'Closing as cleared.',
          ].join('\n'));
          await store.closeIssue(record.issue);
          log.push(`fault: closed #${record.issue} (${record.title}) — absent ${absent} pass(es)`);
        }
        delete state.faults[fingerprint];
      } else {
        state.faults[fingerprint] = { ...record, consecutiveAbsent: absent };
      }
    }
  }

  return log;
}

/** The one status comment on the status-home tracking issue. */
export function renderStatus(report: PassReport, state: LoopState, tracking: number, mention?: string): string {
  const waitingOn = (stage: StageName, match: RegExp): string[] => report.stages
    .filter((s) => s.stage === stage)
    .flatMap((s) => s.items.filter((i) => i.decision === 'skip' && match.test(i.reason)).map((i) => i.ref));
  const faults = Object.values(state.faults).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, 3);
  return [
    STATUS_MARKER,
    `## Loop status — ${report.classification}`,
    '',
    ...(mention ? [mention, ''] : []),
    `Pass ${report.passId} at ${report.endedAt} on ${report.repo}: **${report.classification}** — ${report.because}.`,
    '',
    '| Stage | Rung | Queue | Dispatched | Produced | Blocked | Waiting |',
    '|---|---|---:|---:|---:|---:|---:|',
    ...report.stages.map((s) => `| ${s.stage} | ${s.rung} | ${s.counts.queue} | ${s.counts.dispatched} | ${s.counts.produced} | ${s.counts.blocked} | ${s.counts.waiting} |`),
    '',
    '### Waiting on a person',
    '',
    `- Proposals awaiting \`shaped\`: ${list(waitingOn('shape', /^proposal current/))}`,
    `- Assessments awaiting \`auto\` decisions: ${list(waitingOn('assess', /^assessment current/))}`,
    `- Reviewed pull requests awaiting a human decision: ${list(waitingOn('merge', /stop-line|person merges|HUMAN/))}`,
    `- Merged tickets to check and close: ${list(waitingOn('close', /^merged/))}`,
    '',
    '### Last three faults',
    '',
    ...(faults.length === 0 ? ['None recorded.'] : faults.map((f) => `- #${f.issue} ${f.title} — last seen ${f.lastSeen}, ${f.count} pass(es)`)),
    '',
    `This comment is updated in place each pass on #${tracking}. The full pass log is \`agentsys status --repo <path>\` on the operator's machine.`,
  ].join('\n');
}

const list = (refs: string[]): string => (refs.length === 0 ? 'none' : refs.join(', '));

/** Update the status comment in place, or post it the first time. */
export async function postStatus(store: Store, tracking: number, body: string): Promise<number> {
  const existing = (await store.comments(tracking)).filter((c) => c.body.includes(STATUS_MARKER));
  const current = existing[existing.length - 1];
  if (current) {
    await store.updateComment(current.id, body);
    return current.id;
  }
  return store.createComment(tracking, body);
}

/** The pass log: what each stage saw, decided and did, and why it did nothing when it did nothing. */
export function renderPassLog(report: PassReport): string {
  const lines = [`pass ${report.passId} ${report.dryRun ? '(dry run) ' : ''}on ${report.repo} started ${report.startedAt}`];
  for (const s of report.stages) {
    const c = s.counts;
    lines.push(`== ${s.stage} (rung ${s.rung}) queue=${c.queue} dispatched=${c.dispatched} produced=${c.produced} blocked=${c.blocked} waiting=${c.waiting}`);
    if (s.items.length === 0) lines.push('   (queue empty)');
    for (const i of s.items) {
      const stop = i.stopLine !== undefined ? `  stop-line ${i.stopLine} [${i.stopLineSource}]` : '';
      lines.push(`   ${i.ref}${stop}`);
      lines.push(`      → ${i.decision}: ${i.reason}`);
      if (i.result) lines.push(`      ⇒ ${i.result}`);
    }
    for (const n of s.notes) lines.push(`   ${n}`);
  }
  for (const f of report.faults) lines.push(`fault ${f.kind} in ${f.stage}: ${f.subject} — ${f.detail}`);
  lines.push(`pass ${report.passId}: ${report.classification} — ${report.because}`);
  return lines.join('\n');
}
