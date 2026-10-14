import { createHash } from 'node:crypto';
import type { Issue } from './github.js';
import type { QueueRules } from './queues.js';

/**
 * The queue rules a target repository gets when it ships none of its own.
 *
 * They follow the manifest-dev ticket convention: a ticket is an issue, an effort
 * is an `effort:<slug>` label with one tracking issue carrying the bare `effort`
 * label, a person grants work with `shaped` and then `auto`, and `escalated`,
 * `question` or a human assignee keep the loop off a ticket. A repository that
 * works differently ships `scripts/agent-system/{shape-candidates,auto-candidates}.mjs`
 * on its base branch, and those replace every rule here (see `loadQueueRules`).
 *
 * Nothing here reads a ticket's prose. Bodies are hashed, and scanned only for
 * `Depends on: #N` lines.
 */
export function defaultQueueRules(markerPrefix: string): QueueRules {
  const SHAPE_MARKER = `<!-- ${markerPrefix}-shape-proposal -->`;
  const MARKER = `<!-- ${markerPrefix}-auto-assessment -->`;
  const CLAIM_MARKER = `<!-- ${markerPrefix}-ticket-claim -->`;
  const LOOP_CLAIM_LINE = `Claimed by: ${markerPrefix}-loop`;
  const claimedBy = new RegExp(`^Claimed by:\\s*\`?${escape(markerPrefix)}-loop\`?`, 'm');
  const ALL_EFFORTS = Symbol('all-efforts');

  const dependsOn = (body: string): number[] => {
    const out = new Set<number>();
    for (const line of String(body ?? '').split('\n')) {
      const m = /^\s*Depends on:\s*(.+)$/i.exec(line);
      if (!m) continue;
      for (const n of m[1]!.matchAll(/#(\d+)/g)) out.add(Number(n[1]));
    }
    return [...out].sort((a, b) => a - b);
  };

  // `ALL_EFFORTS` means any `effort:` label; the bare `effort` label marks a tracking issue, not membership.
  const inEffort = (names: string[], effortLabel: string | symbol): boolean => (effortLabel === ALL_EFFORTS
    ? names.some((n) => n.startsWith('effort:'))
    : names.includes(effortLabel as string));

  const candidates = (issues: Issue[], effortLabel: string | symbol): Issue[] => issues
    .filter((i) => {
      const names = labelNames(i);
      if (!open(i) || !inEffort(names, effortLabel) || names.includes('effort')) return false;
      if (names.includes('auto') || names.includes('escalated')) return false;
      return (i.assignees ?? []).length === 0;
    })
    .sort(byNumber);

  const trackingIssue = (issues: Issue[], effortLabel: string): Issue => {
    const found = issues.filter((i) => labelNames(i).includes('effort') && labelNames(i).includes(effortLabel));
    if (found.length === 1) return found[0]!;
    throw new Error(found.length === 0
      ? `No tracking issue for ${effortLabel}: no open issue carries both the bare \`effort\` label and that effort label.`
      : `${found.length} issues carry both \`effort\` and ${effortLabel} (#${found.map((i) => i.number).join(', #')}); an effort has one tracking issue.`);
  };

  const fingerprintRe = /<!--\s*assessment-fingerprint:\s*([0-9a-f]{64})\s*-->/;

  return {
    SHAPE_MARKER,
    // Unshaped, unescalated, unassigned tickets that are not questions or tracking issues; null shapes every effort.
    shapeable: (issues, effortLabel) => issues
      .filter((i) => {
        const names = labelNames(i);
        if (!open(i)) return false;
        if (effortLabel != null && effortLabel !== '' && !names.includes(effortLabel)) return false;
        if (['effort', 'shaped', 'question', 'escalated'].some((l) => names.includes(l))) return false;
        return (i.assignees ?? []).length === 0;
      })
      .sort(byNumber),
    issueBodyHash: (body) => sha256(String(body ?? '').trim()),
    readShapeFingerprint: (comment) => /<!--\s*shape-fingerprint:\s*([0-9a-f]{64})\s*-->/.exec(String(comment ?? ''))?.[1] ?? null,
    renderShapeFingerprint: (hex) => `<!-- shape-fingerprint: ${hex} -->`,

    MARKER,
    CLAIM_MARKER,
    LOOP_CLAIM_LINE,
    ALL_EFFORTS,
    isClaim: (comment) => String(comment ?? '').includes(CLAIM_MARKER) && claimedBy.test(String(comment ?? '')),
    trackingIssue,
    dependsOn,
    candidates,
    // Granted, unclaimed tickets whose every dependency has closed; an unread dependency blocks.
    eligible: (issues, effortLabel, dependencyStates = {}, claimed = []) => {
      const held = new Set(claimed.map(Number));
      return issues
        .filter((i) => {
          const names = labelNames(i);
          if (!open(i) || !inEffort(names, effortLabel) || names.includes('effort')) return false;
          if (!names.includes('auto') || names.includes('escalated')) return false;
          if ((i.assignees ?? []).length > 0 || held.has(Number(i.number))) return false;
          return dependsOn(i.body).every((n) => dependencyStates[n] === 'CLOSED');
        })
        .sort(byNumber);
    },
    // The assessment is current while the candidates, their dependencies and the base head are unchanged.
    decide: ({ issues, effortLabel, dependencyStates, devHead, priorComment }) => {
      const tracking = trackingIssue(issues, effortLabel);
      const cands = candidates(issues, effortLabel);
      const now = sha256([
        `dev:${devHead ?? ''}`,
        ...cands.map((i) => `#${i.number}@${i.updatedAt ?? ''}`),
        ...Object.keys(dependencyStates ?? {}).map(Number).sort((a, b) => a - b).map((n) => `dep#${n}:${dependencyStates[n]}`),
      ].join('\n'));
      const before = priorComment === null ? null : fingerprintRe.exec(priorComment)?.[1] ?? null;
      const reason = before === null ? 'no assessment has been written yet'
        : before !== now ? 'the backlog has moved since the last assessment'
          : `nothing has changed since the last assessment (${cands.length} ticket(s) awaiting a verdict)`;
      return { shouldRun: before !== now, reason, fingerprint: now, trackingNumber: tracking.number, candidateNumbers: cands.map((i) => i.number) };
    },
    renderFingerprint: (hex) => `<!-- assessment-fingerprint: ${hex} -->`,
  };
}

const labelNames = (issue: Issue): string[] => issue.labels ?? [];

const open = (i: Issue): boolean => !i.state || String(i.state).toUpperCase() === 'OPEN';
const byNumber = (a: Issue, b: Issue): number => a.number - b.number;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
