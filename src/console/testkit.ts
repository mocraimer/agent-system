import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Scorecard } from '../eval/scorecard.js';
import type { LoopRecord } from '../eval/scorecard.js';
import { renderReviewMarker } from '../loop/markers.js';
import type { PassReport } from '../loop/supervisor.js';
import { fixtureRules, SHA } from '../loop/testkit.js';
import type { CoordinatorFacts } from './facts.js';
import type { IssueFact, PullFact, StoreSnapshot } from './snapshot.js';

/** Fixture builders for the console's fact model, for the made-up repository `example-org/larkspur`. */

export const RULES = fixtureRules();

export function issue(n: number, over: Partial<IssueFact> = {}): IssueFact {
  return { number: n, title: `ticket ${n}`, state: 'OPEN', labels: [], assignees: [], body: `body of ${n}`, events: [], closes: [], edits: [], comments: [], ...over };
}

export function pull(n: number, over: Partial<PullFact> = {}): PullFact {
  return {
    number: n, title: `pr ${n}`, headRefName: `ticket/${n - 100}`, headRefOid: SHA(`head-${n}`), baseRefName: 'dev', isDraft: false,
    state: 'OPEN', checks: 'success', mergeable: 'MERGEABLE', headMessage: 'feat: x', comments: [], ...over,
  };
}

let commentId = 5000;
export function comment(body: string, createdAt = '2026-09-10T10:00:00Z', author = 'octocat') {
  return { id: commentId++, body, author, createdAt };
}

/** A proposal comment whose fingerprint matches `body`. */
export function proposal(body: string, createdAt?: string) {
  return comment(`${RULES.SHAPE_MARKER}\n${RULES.renderShapeFingerprint(RULES.issueBodyHash(body))}\n\nthe draft`, createdAt);
}

export function claim() {
  return comment(`${RULES.CLAIM_MARKER}\n${RULES.LOOP_CLAIM_LINE}\n\nclaimed`);
}

export function review(head: string, findings: number, independent = true, body = '') {
  return comment(`review text\n\n${renderReviewMarker({ sha: head, findings, independent, reviewer: 'model·high',
    bodyDigest: createHash('sha256').update(body).digest('hex') })}`);
}

export function snapshot(over: Partial<StoreSnapshot> = {}): StoreSnapshot {
  return { repo: 'example-org/larkspur', takenAt: '2026-09-18T12:00:00Z', issues: [], pulls: [], referencedIssues: [], referencedPulls: [], ...over };
}

export function card(id: string, loop: LoopRecord, over: Partial<Scorecard> = {}): Scorecard {
  return {
    id, taskId: id.replace(/^card_/, ''), repo: 'example-org/larkspur', workClass: `loop-${loop.stage}`,
    authority: { type: 'grant', id: 'grant_fixture', version: 1 }, runtime: 'claude-local', profile: 'default',
    settings: { requested: { model: 'm', effort: 'e' }, resolved: { model: 'm', effort: 'e' }, observed: { model: 'm', effort: 'e' } },
    workflowVersion: 'unversioned', attempts: 1, runIds: [`run_${id}`], manifestPaths: [], checks: [], reviewerFindings: [], repairs: [],
    usage: {}, blockers: [], finalStatus: 'completed', loop, createdAt: '2026-09-10T09:00:00Z', ...over,
  };
}

export function pass(classification: PassReport['classification'], because = 'fixture'): PassReport {
  return { passId: 'pass_fixture', repo: 'example-org/larkspur', dryRun: false, startedAt: '2026-09-18T11:00:00Z', endedAt: '2026-09-18T11:05:00Z', classification, because, stages: [], faults: [] };
}

export function coordinator(over: Partial<CoordinatorFacts> = {}): CoordinatorFacts {
  return { runsInFlight: [], scorecards: [], paused: {}, ...over };
}

/* ------------------------------------------------------------ a fixture target repository */

/** The queue modules a fixture repository carries, matching `fixtureRules()`. */
export const FIXTURE_QUEUE_MODULES: Record<string, string> = {
  'shape-candidates.mjs': `import { createHash } from 'node:crypto';
const names = (i) => i.labels.map((l) => (typeof l === 'string' ? l : l.name));
export const SHAPE_MARKER = '<!-- fixture-shape -->';
export const issueBodyHash = (body) => createHash('sha256').update(String(body ?? '').trim()).digest('hex');
export const readShapeFingerprint = (b) => /fixture-fp:([0-9a-f]{64})/.exec(b)?.[1] ?? null;
export const renderShapeFingerprint = (h) => \`<!-- fixture-fp:\${h} -->\`;
export const shapeable = (issues) => issues.filter((i) => !names(i).includes('shaped') && !names(i).includes('effort') && i.assignees.length === 0 && !names(i).includes('question') && !names(i).includes('escalated'));
`,
  'auto-candidates.mjs': `import { createHash } from 'node:crypto';
const names = (i) => i.labels.map((l) => (typeof l === 'string' ? l : l.name));
const hash = (s) => createHash('sha256').update(s).digest('hex');
export const MARKER = '<!-- fixture-assessment -->';
export const CLAIM_MARKER = '<!-- fixture-claim -->';
export const LOOP_CLAIM_LINE = 'Claimed by: fixture-loop';
export const ALL_EFFORTS = Symbol('all');
export const isClaim = (b) => b.includes(CLAIM_MARKER) && b.includes(LOOP_CLAIM_LINE);
export function trackingIssue(issues, effort) {
  const found = issues.filter((i) => names(i).includes('effort') && names(i).includes(effort));
  if (found.length !== 1) throw new Error(\`no single tracking issue for \${effort}\`);
  return found[0];
}
export const dependsOn = (body) => [...String(body ?? '').matchAll(/Depends on: #(\\d+)/g)].map((m) => Number(m[1]));
export const candidates = (issues, effort) => issues.filter((i) => names(i).includes(effort) && !names(i).includes('effort') && !names(i).includes('auto'));
export const eligible = (issues) => issues;
export function decide({ issues, effortLabel, priorComment, devHead }) {
  const cands = candidates(issues, effortLabel);
  const fp = hash(devHead + cands.map((c) => c.number).join(','));
  const before = /fixture-afp:([0-9a-f]{64})/.exec(priorComment ?? '')?.[1];
  const tracking = trackingIssue(issues, effortLabel);
  return { shouldRun: before !== fp, reason: before === fp ? 'unchanged' : 'moved', fingerprint: fp, trackingNumber: tracking.number, candidateNumbers: cands.map((c) => c.number) };
}
export const renderFingerprint = (h) => \`<!-- fixture-afp:\${h} -->\`;
`,
};

export const FIXTURE_SLUG = 'example-org/larkspur';

/**
 * A working clone of a fixture target repository whose origin is a bare
 * repository on disk. The origin URL is GitHub-shaped so the slug reads as the
 * target store's, but every fetch is rewritten to the local path and every push
 * goes to it by `pushurl`: nothing a test does can reach GitHub.
 */
export function fixtureTargetRepo(dir: string, storeConfig: string): { path: string; origin: string } {
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const origin = join(dir, 'origin.git');
  const path = join(dir, 'target');
  mkdirSync(path, { recursive: true });
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=dev', origin);
  git(path, 'init', '--quiet', '--initial-branch=dev');
  git(path, 'config', 'user.name', 'Fixture Operator');
  git(path, 'config', 'user.email', 'operator@example.test');
  git(path, 'config', 'commit.gpgsign', 'false');
  const url = `https://github.com/${FIXTURE_SLUG}.git`;
  git(path, 'remote', 'add', 'origin', url);
  git(path, 'config', `url.${origin}.insteadOf`, url);
  git(path, 'config', 'remote.origin.pushurl', origin);
  mkdirSync(join(path, 'tickets'), { recursive: true });
  mkdirSync(join(path, 'scripts', 'agent-system'), { recursive: true });
  writeFileSync(join(path, 'tickets', 'store-config.md'), storeConfig, 'utf8');
  for (const [name, text] of Object.entries(FIXTURE_QUEUE_MODULES)) writeFileSync(join(path, 'scripts', 'agent-system', name), text, 'utf8');
  git(path, 'add', '.');
  git(path, 'commit', '--quiet', '-m', 'fixture store');
  git(path, 'push', '--quiet', 'origin', 'dev');
  git(path, 'push', '--quiet', 'origin', 'dev:main');
  git(path, 'fetch', '--quiet', 'origin');
  return { path, origin };
}

/** Write a file-backed store (see `FileStore`) holding `snapshot`. */
export function writeStoreFile(path: string, snapshot: StoreSnapshot, login = 'octocat'): void {
  writeFileSync(path, JSON.stringify({ ...snapshot, login, writes: [] }, null, 2), 'utf8');
}
