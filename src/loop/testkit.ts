import { createHash } from 'node:crypto';
import type { UsageEstimate, WindowVerdict } from '../core/admission.js';
import type { AuthorityDecision, DispatchRequest } from '../core/authority.js';
import type { DispatchCommandResult, DispatchTaskInput } from '../commands.js';
import type { LoopRecord, RepairInput, ReviewInput } from '../eval/scorecard.js';
import type { Repo } from './git.js';
import type { Comment, Issue, PullCommit, PullRequest, ReviewThread, Store, WorkflowRun } from './github.js';
import { assertApplicable, assertRemovable } from './labels.js';
import { useMarkerPrefix } from './markers.js';
import type { QueueRules } from './queues.js';
import type { LoopCommands, ReviewedState } from './types.js';

/**
 * Test fixtures for the loop, for a made-up repository, `example-org/larkspur`.
 * The store configuration below uses made-up rungs and tiers so that no test
 * restates a real table, and a test that passes against it proves the loop read
 * the file.
 */
export function fixtureStoreConfig(overrides: {
  defaultRung?: number; typeRows?: string[]; effortRows?: string[]; stageRows?: string[]; limitRows?: string[];
  protocolRows?: string[]; releaseCheckRows?: string[];
} = {}): string {
  return [
    '# Fixture store configuration',
    '',
    '## Stop-lines',
    '',
    '### The rungs',
    '',
    '| Rung | Name | Reached when |',
    '|---|---|---|',
    '| 0 | proposal | p |',
    '| 1 | granted | g |',
    '| 2 | pr-open | o |',
    '| 3 | reviewed | r |',
    '| 4 | clean | c |',
    '| 5 | dev | d |',
    '| 6 | release | l |',
    '| 7 | verified | v |',
    '',
    '### Stop-line by type',
    '',
    '| Type | Stop-line |',
    '|---|---|',
    ...(overrides.typeRows ?? ['| `type:bug` | 3 |', '| `type:chore` | 2 |']),
    `| default — anything else | ${overrides.defaultRung ?? 1} |`,
    '',
    '### Stop-line by effort',
    '',
    '| Effort | Stop-line |',
    '|---|---|',
    ...(overrides.effortRows ?? []),
    '',
    '### Stage tiers',
    '',
    '| Stage | Runtime | Model | Effort | Five-hour % | Weekly % |',
    '|---|---|---|---|---|---|',
    ...(overrides.stageRows ?? [
      '| shape | claude-local | model-shape | low | 1 | 1 |',
      '| assess | claude-local | model-assess | low | 1 | 1 |',
      '| sweep | claude-local | model-sweep | low | 1 | 1 |',
      '| fix | claude-local | model-fix | low | 1 | 1 |',
      '| check | claude-local | model-check | low | 1 | 1 |',
    ]),
    '',
    '### Loop limits',
    '',
    '| Setting | Value |',
    '|---|---|',
    '| stalled after passes | 2 |',
    '| shape runs per pass | 1 |',
    '| fix rounds per pull request | 2 |',
    '| status home | effort:home |',
    '| close merged tickets labelled | auto |',
    ...(overrides.limitRows ?? []),
    '',
    '### Review ladder',
    '',
    '| Author | Order | Runtime | Model | Effort | Five-hour % | Weekly % |',
    '|---|---|---|---|---|---|---|',
    '| claude | 1 | pi-local | model-other-1 | high | 0 | 1 |',
    '| claude | 2 | pi-local | model-other-2 | high | 0 | 1 |',
    '| claude | 3 | claude-local | model-same | high | 1 | 1 |',
    '| pi | 1 | claude-local | model-same | high | 1 | 1 |',
    '',
    '## The coordinator\'s protocol',
    '',
    '### Coordinator protocol',
    '',
    '| Setting | Value |',
    '|---|---|',
    ...(overrides.protocolRows ?? [
      `| marker prefix | ${FIXTURE_MARKER_PREFIX} |`,
      '| release branch | main |',
      '| deploy workflow | Deploy |',
      '| deploy scope command | node scripts/agent-system/resolve-deploy-scope.mjs {deploy-jobs} {deploy-workflow} |',
    ]),
    '',
    '### Release checks',
    '',
    '| Check | Runs in | Command | Env files | Timeout minutes | Other exits |',
    '|---|---|---|---|---|---|',
    ...(overrides.releaseCheckRows ?? [
      '| verify-production | base | node scripts/agent-system/verify-production.mjs --commit {commit} --components {scope.components} --status {scope.status} --note {scope.reason} --out {scratch}/verification.json | - | 10 | blocked |',
      '| check-live-surfaces | base | node scripts/agent-system/check-live-surfaces.mjs | - | 10 | blocked |',
      '| web e2e | deployed/web | npm run test:e2e | web/.env.e2e, api/.env | 60 | fail |',
    ]),
    '',
  ].join('\n');
}

/**
 * The fixture repository's marker prefix, as its store configuration states it. Set
 * on import, so a marker a test renders before any pass reads the policy is the
 * one the pass will look for.
 */
export const FIXTURE_MARKER_PREFIX = 'larkspur';
useMarkerPrefix(FIXTURE_MARKER_PREFIX);

export const SHA = (seed: string): string => createHash('sha1').update(seed).digest('hex');

export class FakeRepo implements Repo {
  readonly path = '/fixture/repo';
  worktrees = new Set<string>();
  added: string[] = [];
  constructor(public storeConfig = fixtureStoreConfig(), public heads: Record<string, string> = {}) {}
  slugName = 'example-org/larkspur';
  slug(): Promise<string> { return Promise.resolve(this.slugName); }
  fetch(): Promise<void> { return Promise.resolve(); }
  /** Further files at every ref, by path; the store configuration is always present. */
  files = new Map<string, string>();
  show(_ref: string, file: string): Promise<string> {
    if (file === 'tickets/store-config.md') return Promise.resolve(this.storeConfig);
    const content = this.files.get(file);
    return content !== undefined ? Promise.resolve(content) : Promise.reject(new Error(`no fixture file ${file}`));
  }
  has(_ref: string, file: string): Promise<boolean> {
    return Promise.resolve(file === 'tickets/store-config.md' || this.files.has(file));
  }
  revParse(ref: string, dir?: string): Promise<string> { return Promise.resolve(this.heads[dir ? `${dir}:${ref}` : ref] ?? SHA(ref)); }
  log(): Promise<Array<{ sha: string; message: string }>> { return Promise.resolve([]); }
  addWorktree(dir: string): Promise<void> { this.worktrees.add(dir); this.added.push(dir); return Promise.resolve(); }
  removeWorktree(dir: string): Promise<void> { this.worktrees.delete(dir); return Promise.resolve(); }
}

export interface Write { kind: string; target: number; body?: string }

/** A commit as the store lists it, with the time GitHub reports it was committed. */
export function commitAt(oid: string, committedDate: string, message = 'feat: x\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>'): PullCommit {
  return { oid, message, committedDate };
}

/** An in-memory store that records every write. */
export class FakeStore implements Store {
  readonly repo = 'example-org/larkspur';
  issues: Issue[] = [];
  pulls: PullRequest[] = [];
  closedPulls: PullRequest[] = [];
  commentsBy = new Map<number, Comment[]>();
  reviewThreadsBy = new Map<number, ReviewThread[]>();
  commitsBy = new Map<number, PullCommit[]>();
  /** The heads force-pushes took off each pull request, oldest first. */
  replacedHeadsBy = new Map<number, string[]>();
  /** What `commitsAbove` lists for a head: the commits a branch at that head added to its base. */
  addedAtHead = new Map<string, string[]>();
  /** Who applied each label, by pull request then label; `labelActorError` makes the read fail instead. */
  labelActors = new Map<number, Map<string, string>>();
  labelActorError?: string;
  /** When set, the force-push history reads fail with this message. */
  historyError?: string;
  branchHeads = new Map<string, string>();
  runs: Array<WorkflowRun & { workflow: string; branch: string }> = [];
  writes: Write[] = [];
  private nextId = 1000;

  addIssue(issue: Partial<Issue> & { number: number }): Issue {
    const full: Issue = { title: `issue ${issue.number}`, state: 'OPEN', updatedAt: 't', labels: [], assignees: [], body: '', ...issue };
    this.issues.push(full);
    return full;
  }
  addPull(pr: Partial<PullRequest> & { number: number; headRefOid: string }, commitMessage = 'feat: x\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>'): PullRequest {
    const full: PullRequest = { title: `pr ${pr.number}`, headRefName: `ticket/${pr.number}`, baseRefName: 'dev', isDraft: false, body: '', author: 'someone', labels: [], state: 'OPEN', ...pr };
    this.pulls.push(full);
    this.commitsBy.set(pr.number, [{ oid: pr.headRefOid, message: commitMessage }]);
    return full;
  }
  addComment(number: number, body: string, author = 'operator'): Comment {
    const c: Comment = { id: this.nextId++, body, author, createdAt: new Date().toISOString() };
    this.commentsBy.set(number, [...(this.commentsBy.get(number) ?? []), c]);
    return c;
  }

  listOpenIssues(): Promise<Issue[]> { return Promise.resolve(this.issues.filter((i) => i.state === 'OPEN')); }
  issue(n: number): Promise<Issue | undefined> { return Promise.resolve(this.issues.find((i) => i.number === n)); }
  issueState(n: number): Promise<'OPEN' | 'CLOSED' | 'UNKNOWN'> {
    const found = this.issues.find((i) => i.number === n);
    return Promise.resolve(found ? (found.state === 'OPEN' ? 'OPEN' : 'CLOSED') : 'UNKNOWN');
  }
  comments(n: number): Promise<Comment[]> { return Promise.resolve([...(this.commentsBy.get(n) ?? [])]); }
  labelActor(n: number, label: string): Promise<string | undefined> {
    return this.labelActorError ? Promise.reject(new Error(this.labelActorError)) : Promise.resolve(this.labelActors.get(n)?.get(label));
  }
  /** Record who applied a label, as the store's event history would. */
  setLabelActor(n: number, label: string, actor: string): void {
    this.labelActors.set(n, new Map([...(this.labelActors.get(n) ?? []), [label, actor]]));
  }
  reviewThreads(n: number): Promise<ReviewThread[]> { return Promise.resolve([...(this.reviewThreadsBy.get(n) ?? [])]); }
  listOpenPulls(): Promise<PullRequest[]> { return Promise.resolve(this.pulls.filter((p) => p.state === 'OPEN')); }
  pullsFromHead(branch: string): Promise<PullRequest[]> { return Promise.resolve([...this.pulls, ...this.closedPulls].filter((p) => p.headRefName === branch)); }
  mergedPulls(base: string, head?: string, since?: string): Promise<PullRequest[]> {
    this.mergedSince.push(since);
    return Promise.resolve(this.closedPulls.filter((p) => p.state === 'MERGED' && p.baseRefName === base && (!head || p.headRefName === head)
      && (!since || Date.parse(p.mergedAt ?? '') >= Date.parse(since.slice(0, 10)))));
  }
  /** The `since` each mergedPulls call asked for. */
  mergedSince: Array<string | undefined> = [];
  openPulls(base: string, head: string): Promise<PullRequest[]> { return Promise.resolve(this.pulls.filter((p) => p.state === 'OPEN' && p.baseRefName === base && p.headRefName === head)); }
  pullCommits(n: number): Promise<PullCommit[]> { return Promise.resolve(this.commitsBy.get(n) ?? []); }
  replacedPullHeads(n: number): Promise<string[]> {
    return this.historyError ? Promise.reject(new Error(this.historyError)) : Promise.resolve([...(this.replacedHeadsBy.get(n) ?? [])]);
  }
  commitsAbove(_base: string, head: string): Promise<string[]> {
    return this.historyError ? Promise.reject(new Error(this.historyError)) : Promise.resolve([...(this.addedAtHead.get(head) ?? [])]);
  }
  branchHead(b: string): Promise<string> { return Promise.resolve(this.branchHeads.get(b) ?? this.pulls.find((p) => p.headRefName === b)?.headRefOid ?? SHA(b)); }
  runsForCommit(b: string, sha: string): Promise<Array<WorkflowRun & { workflow: string }>> { return Promise.resolve(this.runs.filter((r) => r.branch === b && r.headSha === sha)); }
  runJobs(): Promise<Array<{ name: string; conclusion: string | null }>> { return Promise.resolve([]); }

  createComment(n: number, body: string): Promise<number> {
    this.writes.push({ kind: 'comment', target: n, body });
    return Promise.resolve(this.addComment(n, body).id);
  }
  updateComment(id: number, body: string): Promise<void> {
    this.writes.push({ kind: 'update-comment', target: id, body });
    for (const list of this.commentsBy.values()) for (const c of list) if (c.id === id) c.body = body;
    return Promise.resolve();
  }
  deleteComment(id: number): Promise<void> {
    this.writes.push({ kind: 'delete-comment', target: id });
    for (const [n, list] of this.commentsBy) this.commentsBy.set(n, list.filter((c) => c.id !== id));
    return Promise.resolve();
  }
  createIssue(input: { title: string; body: string; labels: string[] }): Promise<number> {
    const number = this.nextId++;
    this.writes.push({ kind: 'issue', target: number, body: input.body });
    this.addIssue({ number, title: input.title, body: input.body, labels: input.labels });
    return Promise.resolve(number);
  }
  updateIssueBody(n: number, body: string): Promise<void> {
    this.writes.push({ kind: 'update-issue', target: n, body });
    const found = this.issues.find((i) => i.number === n);
    if (found) found.body = body;
    return Promise.resolve();
  }
  createPull(input: { base: string; head: string; title: string; body: string }): Promise<number> {
    const number = this.nextId++;
    this.writes.push({ kind: 'pull', target: number, body: input.body });
    this.pulls.push({ number, title: input.title, headRefName: input.head, headRefOid: SHA(input.head), baseRefName: input.base, isDraft: false, body: input.body, author: 'operator', labels: [], state: 'OPEN' });
    return Promise.resolve(number);
  }
  updatePullBody(n: number, body: string): Promise<void> { this.writes.push({ kind: 'update-pull', target: n, body }); return Promise.resolve(); }
  async addLabel(n: number, label: string): Promise<void> {
    assertApplicable(label);
    this.writes.push({ kind: 'add-label', target: n, body: label });
    const item = this.pulls.find((p) => p.number === n) ?? this.issues.find((i) => i.number === n);
    if (item && !item.labels.includes(label)) item.labels = [...item.labels, label];
  }
  async addLabels(n: number, labels: string[]): Promise<void> {
    this.writes.push({ kind: 'add-labels', target: n, body: labels.join(',') });
    const item = this.pulls.find((p) => p.number === n) ?? this.issues.find((i) => i.number === n);
    if (item) item.labels = [...new Set([...item.labels, ...labels])];
  }
  async removeLabel(n: number, label: string): Promise<void> {
    assertRemovable(label);
    return this.removeOperatorLabel(n, label);
  }
  removeOperatorLabel(n: number, label: string): Promise<void> {
    this.writes.push({ kind: 'remove-label', target: n, body: label });
    const item = this.pulls.find((p) => p.number === n) ?? this.issues.find((i) => i.number === n);
    if (item) item.labels = item.labels.filter((l) => l !== label);
    return Promise.resolve();
  }
  closeIssue(n: number, reason: 'completed' | 'not planned' = 'completed'): Promise<void> {
    this.writes.push({ kind: 'close', target: n, body: reason });
    const found = this.issues.find((i) => i.number === n);
    if (found) found.state = 'CLOSED';
    return Promise.resolve();
  }
  removeAssignees(n: number, logins: string[]): Promise<void> {
    this.writes.push({ kind: 'unassign', target: n, body: logins.join(',') });
    const found = this.issues.find((i) => i.number === n);
    if (found) found.assignees = found.assignees.filter((a) => !logins.includes(a));
    return Promise.resolve();
  }
  merges: Array<{ number: number; head: string }> = [];
  mergePull(n: number, head: string): Promise<void> {
    this.writes.push({ kind: 'merge', target: n });
    this.merges.push({ number: n, head });
    return Promise.resolve();
  }
}

/**
 * The repository's queue rules, reduced to what the loop's tests exercise.
 * The real ones are the target repository's modules; these only have to be
 * consistent enough to drive a stage.
 */
export function fixtureRules(): QueueRules {
  const labels = (i: Issue): string[] => i.labels;
  const hash = (body: string): string => createHash('sha256').update(String(body ?? '').trim()).digest('hex');
  const ALL = Symbol('all');
  const inEffort = (i: Issue, e: string | symbol): boolean => (e === ALL ? labels(i).some((l) => l.startsWith('effort:')) : labels(i).includes(e as string));
  return {
    SHAPE_MARKER: '<!-- fixture-shape -->',
    shapeable: (issues) => issues.filter((i) => !labels(i).includes('shaped') && !labels(i).includes('effort') && i.assignees.length === 0 && !labels(i).includes('question') && !labels(i).includes('escalated')),
    issueBodyHash: hash,
    readShapeFingerprint: (b) => /fixture-fp:([0-9a-f]{64})/.exec(b)?.[1] ?? null,
    renderShapeFingerprint: (h) => `<!-- fixture-fp:${h} -->`,
    MARKER: '<!-- fixture-assessment -->',
    CLAIM_MARKER: '<!-- fixture-claim -->',
    LOOP_CLAIM_LINE: 'Claimed by: fixture-loop',
    ALL_EFFORTS: ALL,
    isClaim: (b) => b.includes('<!-- fixture-claim -->') && b.includes('Claimed by: fixture-loop'),
    trackingIssue: (issues, effort) => {
      const found = issues.filter((i) => labels(i).includes('effort') && labels(i).includes(effort));
      if (found.length !== 1) throw new Error(`no single tracking issue for ${effort}`);
      return found[0]!;
    },
    dependsOn: (body) => [...String(body ?? '').matchAll(/Depends on: #(\d+)/g)].map((m) => Number(m[1])),
    candidates: (issues, effort) => issues.filter((i) => inEffort(i, effort) && !labels(i).includes('effort') && !labels(i).includes('auto')),
    eligible: (issues) => issues,
    decide: ({ issues, effortLabel, priorComment, devHead }) => {
      const cands = issues.filter((i) => labels(i).includes(effortLabel) && !labels(i).includes('effort') && !labels(i).includes('auto'));
      const fp = hash(`${devHead}${cands.map((c) => c.number).join(',')}`);
      const before = /fixture-afp:([0-9a-f]{64})/.exec(priorComment ?? '')?.[1];
      const tracking = issues.find((i) => labels(i).includes('effort') && labels(i).includes(effortLabel))!;
      return { shouldRun: before !== fp, reason: before === fp ? 'unchanged' : 'moved', fingerprint: fp, trackingNumber: tracking.number, candidateNumbers: cands.map((c) => c.number) };
    },
    renderFingerprint: (h) => `<!-- fixture-afp:${h} -->`,
  };
}

export interface ScriptedDispatch {
  input: DispatchTaskInput;
}

/**
 * Loop commands with every coordinator path scripted. `onDispatch` decides what
 * each dispatch returns and may write the run's output file.
 */
export class FakeCommands implements LoopCommands {
  dispatched: DispatchTaskInput[] = [];
  /** The dispatches a runtime actually started, which is what the run store would hold. */
  ran: DispatchTaskInput[] = [];
  refuse = new Set<string>();
  unready = new Set<string>();
  deniedActions = new Set<string>();
  /** Runtimes no grant covers, so a stage's other option is the one that can start. */
  deniedRuntimes = new Set<string>();
  loops: Array<{ taskId: string; record: Partial<LoopRecord> }> = [];
  attestedDescriptions = new Map<string, { reviewCommentAtAttestation?: number; round?: number; bodyDigest?: string }>();
  reviews: Array<{ taskId: string; input: ReviewInput }> = [];
  repairs: Array<{ taskId: string; input: RepairInput }> = [];
  running = new Set<string>();
  execs: Array<{ command: string; args: string[] }> = [];
  execResult: (command: string, args: string[]) => { code: number | null; stdout: string; stderr: string } = () => ({ code: 0, stdout: 'ok', stderr: '' });
  constructor(public onDispatch: (input: DispatchTaskInput) => DispatchCommandResult | Promise<DispatchCommandResult> = completed) {}

  dispatch(input: DispatchTaskInput): Promise<DispatchCommandResult> {
    this.dispatched.push(input);
    if (this.refuse.has(input.runtime)) return Promise.resolve(refusedByAdmission(input));
    return Promise.resolve(this.onDispatch(input)).then((result) => {
      const sent = !(result.outcome.kind === 'checks-failed' && result.outcome.promptNotSent === true);
      if (result.runtimeDispatched && result.outcome.kind !== 'quota-waiting' && sent) this.ran.push(input);
      return result;
    });
  }
  authorize(req: DispatchRequest): AuthorityDecision {
    const denied = req.actions.find((a) => this.deniedActions.has(a)) ?? (this.deniedRuntimes.has(req.runtime) ? req.actions[0] : undefined);
    if (denied) return { allowed: false, outcome: { kind: 'awaiting-approval', taskId: req.taskId, summary: `no grant covers ${denied}`, nextAction: 'grant it' } };
    return { allowed: true, authority: { type: 'grant', id: 'grant_fixture', version: 1 }, limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 0 } };
  }
  readiness(runtime: string) {
    return Promise.resolve(this.unready.has(runtime) ? { kind: 'setup-blocked' as const, summary: `${runtime} unready`, nextAction: 'fix it' } : undefined);
  }
  admissionPreview(runtime: string, _taskId?: string, _estimate?: UsageEstimate): Promise<{ admitted: boolean; reason?: string; windows?: WindowVerdict[] }> {
    return Promise.resolve(this.refuse.has(runtime) ? { admitted: false, reason: `${runtime} over its threshold` } : { admitted: true });
  }
  recover(): Promise<void> { return Promise.resolve(); }
  inFlight(taskId: string): boolean { return this.running.has(taskId); }
  wroteComment(commentId: number): boolean { return this.loops.some((l) => l.record.wrote === `comment ${commentId}`); }
  reviewsRun(repo: string, pr: number): ReviewedState[] {
    const seen = new Set<string>();
    return this.ran.filter((i) => i.repo === repo && i.workClass === 'loop-review' && i.loop?.item === `PR #${pr}`).flatMap((i): ReviewedState[] => {
      const state = { head: i.loop!.head!.toLowerCase(), ...(i.loop!.bodyDigest ? { bodyDigest: i.loop!.bodyDigest } : {}) };
      const key = `${state.head}:${state.bodyDigest ?? ''}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [state];
    });
  }
  attestedDescription(_repo: string, pr: number, head: string): { reviewCommentAtAttestation?: number; round?: number; bodyDigest?: string } | undefined {
    return this.attestedDescriptions.get(`${pr}:${head}`);
  }
  recordLoop(taskId: string, record: Partial<LoopRecord>): void { this.loops.push({ taskId, record }); }
  recordReview(taskId: string, input: ReviewInput): void { this.reviews.push({ taskId, input }); }
  recordRepair(taskId: string, input: RepairInput): void { this.repairs.push({ taskId, input }); }
  exec(command: string, args: string[]) {
    this.execs.push({ command, args });
    return Promise.resolve(this.execResult(command, args));
  }
}

export function completed(input: DispatchTaskInput): DispatchCommandResult {
  return {
    outcome: { kind: 'completed', taskId: input.taskId, summary: 'fixture run completed', nextAction: 'none' },
    recovered: [],
    runtimeDispatched: true,
    run: {
      id: `run_${input.taskId}`, taskId: input.taskId, attempt: 1, authority: { type: 'grant', id: 'grant_fixture', version: 1 },
      limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 0 }, runtime: input.runtime, profile: 'default',
      actions: input.actions, settings: {
        requested: { model: input.settings.model ?? 'x', effort: input.settings.effort ?? 'x' },
        resolved: { model: input.settings.model ?? 'x', effort: input.settings.effort ?? 'x' },
        observed: { model: 'unknown', effort: 'unknown' },
      },
      startedAt: 'now', status: 'completed', sessionId: `session-${input.taskId}`,
    },
  };
}

export function refusedByAdmission(input: DispatchTaskInput): DispatchCommandResult {
  return {
    outcome: { kind: 'quota-waiting', taskId: input.taskId, summary: 'does not fit the weekly window', nextAction: 'wait' },
    recovered: [],
    runtimeDispatched: false,
  };
}

/** The output path a stage told the run to write, read back out of its prompt. */
export function outputFileIn(prompt: string): string | undefined {
  return /(\/[^\s`]*\/out\/[^\s`]+\.md)/.exec(prompt)?.[1];
}

/** The operator floor the fixture repository runs under: its integration pull requests target `dev`. */
export const FIXTURE_FLOOR = { prBases: { 'example-org/larkspur': 'dev' }, readOnlyProjects: [] };
