import { spawn } from 'node:child_process';
import { assertApplicable, assertRemovable, statusLabelDefinition } from './labels.js';

/**
 * The ticket store and pull requests, as the loop sees them.
 *
 * An interface so every stage can be driven by a fixture store in tests; `GhStore`
 * is the one implementation that talks to GitHub, through the operator's `gh`
 * login. Every write the loop makes to GitHub goes through a method here, which
 * is what lets a dry run prove it wrote nothing: it is given a store whose write
 * methods throw.
 */

export interface Issue {
  number: number;
  title: string;
  state: string;
  updatedAt: string;
  /** When the issue was opened; absent from stores that do not report it. */
  createdAt?: string;
  labels: string[];
  assignees: string[];
  body: string;
}

export interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface ReviewThreadComment {
  body: string;
  commitId?: string;
}

export interface ReviewThread {
  resolved: boolean;
  comments: ReviewThreadComment[];
}

export interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isDraft: boolean;
  body: string;
  author: string;
  /** The pull request's own labels, which are not its ticket's. */
  labels: string[];
  state?: string;
  mergedAt?: string | null;
  /** The commit a merge created, for a merged pull request. */
  mergeCommit?: string;
}

export interface PullCommit {
  oid: string;
  message: string;
  /** When the commit was committed, as GitHub reports it; absent from stores that do not. */
  committedDate?: string;
}

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  headSha: string;
  /** The current attempt for this run; a GitHub rerun keeps the same run id. */
  runAttempt?: number;
  /** GitHub's run_started_at, updated when an attempt starts. */
  attemptStartedAt?: string;
}

export interface StoreReader {
  readonly repo: string;
  listOpenIssues(): Promise<Issue[]>;
  issue(number: number): Promise<Issue | undefined>;
  issueState(number: number): Promise<'OPEN' | 'CLOSED' | 'UNKNOWN'>;
  comments(number: number): Promise<Comment[]>;
  /**
   * Who last applied `label` to an issue or pull request, from its event history; undefined where no
   * event names one. Throws when the history cannot be read, so a caller can tell that from none.
   */
  labelActor(number: number, label: string): Promise<string | undefined>;
  reviewThreads(number: number): Promise<ReviewThread[]>;
  listOpenPulls(): Promise<PullRequest[]>;
  pullsFromHead(branch: string): Promise<PullRequest[]>;
  /**
   * Pull requests merged into `base`, optionally from one `head`, optionally only
   * those merged on or after `since` (an ISO date). Every one of them, or an error.
   */
  mergedPulls(base: string, head?: string, since?: string): Promise<PullRequest[]>;
  openPulls(base: string, head: string): Promise<PullRequest[]>;
  pullCommits(number: number): Promise<PullCommit[]>;
  /** The heads force-pushes took off a pull request, oldest first. Throws when GitHub's history of them is incomplete. */
  replacedPullHeads(number: number): Promise<string[]>;
  /** The commits reachable from `head` and not from `base`: what a branch at `head` added to `base`. */
  commitsAbove(base: string, head: string): Promise<string[]>;
  branchHead(branch: string): Promise<string>;
  /** Complete workflow history for one branch/commit, latest attempt first, or an error. */
  runsForCommit(branch: string, sha: string): Promise<Array<WorkflowRun & { workflow: string }>>;
  /** The jobs of one workflow run, by name and conclusion. */
  runJobs(runId: number): Promise<Array<{ name: string; conclusion: string | null }>>;
}

export interface StoreWriter {
  createComment(number: number, body: string): Promise<number>;
  updateComment(id: number, body: string): Promise<void>;
  deleteComment(id: number): Promise<void>;
  createIssue(input: { title: string; body: string; labels: string[] }): Promise<number>;
  updateIssueBody(number: number, body: string): Promise<void>;
  createPull(input: { base: string; head: string; title: string; body: string }): Promise<number>;
  updatePullBody(number: number, body: string): Promise<void>;
  /**
   * A merge commit into the pull request's base, which must be `into` and must not
   * be `never` (the release branch). Never squash, never rebase, never admin.
   */
  mergePull(number: number, expectedHead: string, bases: { into: string; never: string }): Promise<void>;
  /** The console's operator actions: a person's acts, made through the same login. */
  addLabels(number: number, labels: string[]): Promise<void>;
  removeOperatorLabel(number: number, label: string): Promise<void>;
  /** Add one of the loop-owned status labels. */
  addLabel(number: number, label: string): Promise<void>;
  /** Remove a loop-owned label or an operator instruction the loop consumed. */
  removeLabel(number: number, label: string): Promise<void>;
  /** Close an issue, with the loop's completed default or a console-selected reason. */
  closeIssue(number: number, reason?: 'completed' | 'not planned'): Promise<void>;
  removeAssignees(number: number, logins: string[]): Promise<void>;
}

export type Store = StoreReader & StoreWriter;

/** Run `gh`, optionally feeding stdin, and return stdout. */
export function runGh(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    proc.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`gh ${args.slice(0, 3).join(' ')} exited ${code}: ${err.trim().slice(0, 500)}`));
    });
    proc.stdin.end(input ?? '');
  });
}

const labelNames = (labels: unknown): string[] => (Array.isArray(labels) ? labels : [])
  .map((l: unknown) => (typeof l === 'string' ? l : (l as { name?: string }).name ?? ''))
  .filter((n) => n !== '');

const logins = (users: unknown): string[] => (Array.isArray(users) ? users : [])
  .map((u: unknown) => (u as { login?: string }).login ?? '')
  .filter((n) => n !== '');

function toIssue(raw: Record<string, unknown>): Issue {
  return {
    number: Number(raw['number']),
    title: String(raw['title'] ?? ''),
    state: String(raw['state'] ?? ''),
    updatedAt: String(raw['updatedAt'] ?? ''),
    ...(typeof raw['createdAt'] === 'string' ? { createdAt: raw['createdAt'] } : {}),
    labels: labelNames(raw['labels']),
    assignees: logins(raw['assignees']),
    body: String(raw['body'] ?? ''),
  };
}

function toPull(raw: Record<string, unknown>): PullRequest {
  return {
    number: Number(raw['number']),
    title: String(raw['title'] ?? ''),
    headRefName: String(raw['headRefName'] ?? ''),
    headRefOid: String(raw['headRefOid'] ?? ''),
    baseRefName: String(raw['baseRefName'] ?? ''),
    isDraft: raw['isDraft'] === true,
    body: String(raw['body'] ?? ''),
    author: String((raw['author'] as { login?: string } | undefined)?.login ?? ''),
    labels: labelNames(raw['labels']),
    ...(typeof raw['state'] === 'string' ? { state: raw['state'] } : {}),
    ...(raw['mergedAt'] !== undefined ? { mergedAt: raw['mergedAt'] as string | null } : {}),
    ...(typeof (raw['mergeCommit'] as { oid?: unknown } | null)?.oid === 'string' ? { mergeCommit: (raw['mergeCommit'] as { oid: string }).oid } : {}),
  };
}

const PULL_FIELDS = 'number,title,headRefName,headRefOid,baseRefName,isDraft,body,author,labels,state,mergedAt,mergeCommit';

/** `gh api --paginate --jq` emits one JSON value per line; read them as a stream. */
const jsonLines = (text: string): unknown[] => text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as unknown);

export class GhStore implements Store {
  constructor(readonly repo: string) {}

  async listOpenIssues(): Promise<Issue[]> {
    const LIMIT = 1000;
    const raw = JSON.parse(await runGh([
      'issue', 'list', '--repo', this.repo, '--state', 'open', '--limit', String(LIMIT),
      '--json', 'number,title,state,updatedAt,createdAt,labels,assignees,body',
    ])) as Array<Record<string, unknown>>;
    // `gh` truncates at the limit without saying so; a full page is not a whole backlog.
    if (raw.length >= LIMIT) throw new Error(`Read ${raw.length} open issues, the --limit; part of the store may be invisible.`);
    return raw.map(toIssue);
  }

  async issue(number: number): Promise<Issue | undefined> {
    try {
      return toIssue(JSON.parse(await runGh([
        'issue', 'view', String(number), '--repo', this.repo, '--json', 'number,title,state,updatedAt,createdAt,labels,assignees,body',
      ])) as Record<string, unknown>);
    } catch {
      return undefined;
    }
  }

  async issueState(number: number): Promise<'OPEN' | 'CLOSED' | 'UNKNOWN'> {
    const found = await this.issue(number);
    if (!found) return 'UNKNOWN';
    return found.state.toUpperCase() === 'CLOSED' ? 'CLOSED' : found.state.toUpperCase() === 'OPEN' ? 'OPEN' : 'UNKNOWN';
  }

  async comments(number: number): Promise<Comment[]> {
    const out = await runGh([
      'api', `repos/${this.repo}/issues/${number}/comments`, '--paginate',
      '--jq', '.[] | {id, body, author: .user.login, createdAt: .created_at}',
    ]);
    return jsonLines(out).map((c) => {
      const r = c as Record<string, unknown>;
      return { id: Number(r['id']), body: String(r['body'] ?? ''), author: String(r['author'] ?? ''), createdAt: String(r['createdAt'] ?? '') };
    });
  }

  async labelActor(number: number, label: string): Promise<string | undefined> {
    const out = await runGh([
      'api', `repos/${this.repo}/issues/${number}/events`, '--paginate',
      '--jq', `.[] | select(.event == "labeled" and .label.name == ${JSON.stringify(label)}) | {actor: .actor.login}`,
    ]);
    const actor = (jsonLines(out).at(-1) as { actor?: unknown } | undefined)?.actor;
    return typeof actor === 'string' && actor !== '' ? actor : undefined;
  }

  async reviewThreads(number: number): Promise<ReviewThread[]> {
    const [owner, name] = this.repo.split('/', 2);
    if (!owner || !name) throw new Error(`Repository slug "${this.repo}" is not owner/name, so review threads cannot be read.`);
    const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage}nodes{isResolved comments(first:100){pageInfo{hasNextPage}nodes{body commit{oid}}}}}}}}`;
    const raw = JSON.parse(await runGh([
      'api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`,
    ])) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              pageInfo?: { hasNextPage?: boolean };
              nodes?: Array<{
                isResolved?: boolean;
                comments?: {
                  pageInfo?: { hasNextPage?: boolean };
                  nodes?: Array<{ body?: string; commit?: { oid?: string } | null }>;
                };
              }>;
            };
          };
        };
      };
    };
    const connection = raw.data?.repository?.pullRequest?.reviewThreads;
    if (!connection) throw new Error(`GitHub returned no review-thread connection for PR #${number}.`);
    if (connection.pageInfo?.hasNextPage || connection.nodes?.some((thread) => thread.comments?.pageInfo?.hasNextPage)) {
      throw new Error(`PR #${number} has more than 100 review threads or comments; refusing to undercount active findings.`);
    }
    return (connection.nodes ?? []).map((thread) => ({
      resolved: thread.isResolved === true,
      comments: (thread.comments?.nodes ?? []).map((comment) => ({
        body: comment.body ?? '',
        ...(comment.commit?.oid ? { commitId: comment.commit.oid } : {}),
      })),
    }));
  }

  async listOpenPulls(): Promise<PullRequest[]> {
    const raw = JSON.parse(await runGh([
      'pr', 'list', '--repo', this.repo, '--state', 'open', '--limit', '200', '--json', PULL_FIELDS,
    ])) as Array<Record<string, unknown>>;
    return raw.map(toPull);
  }

  async pullsFromHead(branch: string): Promise<PullRequest[]> {
    const raw = JSON.parse(await runGh([
      'pr', 'list', '--repo', this.repo, '--head', branch, '--state', 'all', '--limit', '20', '--json', PULL_FIELDS,
    ])) as Array<Record<string, unknown>>;
    return raw.map(toPull);
  }

  async mergedPulls(base: string, head?: string, since?: string): Promise<PullRequest[]> {
    const LIMIT = 2000;
    const raw = JSON.parse(await runGh([
      'pr', 'list', '--repo', this.repo, '--base', base, ...(head ? ['--head', head] : []),
      ...(since ? ['--search', `merged:>=${since.slice(0, 10)}`] : []),
      '--state', 'merged', '--limit', String(LIMIT), '--json', PULL_FIELDS,
    ])) as Array<Record<string, unknown>>;
    // `gh` truncates at the limit without saying so, and a merged pull request the
    // loop cannot see would put its ticket back into the work queues.
    if (raw.length >= LIMIT) throw new Error(`Read ${raw.length} merged pull requests into ${base}, the --limit; some are invisible. Narrow the window or paginate.`);
    return raw.map(toPull);
  }

  async openPulls(base: string, head: string): Promise<PullRequest[]> {
    const raw = JSON.parse(await runGh([
      'pr', 'list', '--repo', this.repo, '--base', base, '--head', head, '--state', 'open', '--limit', '20', '--json', PULL_FIELDS,
    ])) as Array<Record<string, unknown>>;
    return raw.map(toPull);
  }

  async pullCommits(number: number): Promise<PullCommit[]> {
    const raw = JSON.parse(await runGh(['pr', 'view', String(number), '--repo', this.repo, '--json', 'commits'])) as {
      commits?: Array<{ oid?: string; messageHeadline?: string; messageBody?: string; committedDate?: string }>;
    };
    return (raw.commits ?? []).map((c) => ({
      oid: c.oid ?? '', message: `${c.messageHeadline ?? ''}\n\n${c.messageBody ?? ''}`,
      ...(c.committedDate ? { committedDate: c.committedDate } : {}),
    }));
  }

  async replacedPullHeads(number: number): Promise<string[]> {
    const [owner, name] = this.repo.split('/', 2);
    if (!owner || !name) throw new Error(`Repository slug "${this.repo}" is not owner/name, so force-push history cannot be read.`);
    const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){timelineItems(first:100,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){pageInfo{hasNextPage}nodes{... on HeadRefForcePushedEvent{beforeCommit{oid}}}}}}}`;
    const raw = JSON.parse(await runGh([
      'api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`,
    ])) as {
      data?: { repository?: { pullRequest?: { timelineItems?: {
        pageInfo?: { hasNextPage?: boolean };
        nodes?: Array<{ beforeCommit?: { oid?: string } | null } | null>;
      } } } };
    };
    const connection = raw.data?.repository?.pullRequest?.timelineItems;
    if (!connection) throw new Error(`GitHub returned no force-push history for PR #${number}.`);
    if (connection.pageInfo?.hasNextPage) throw new Error(`PR #${number} has more than 100 force-pushes; refusing to read a partial history.`);
    return (connection.nodes ?? []).map((event) => {
      const oid = event?.beforeCommit?.oid;
      if (!oid) throw new Error(`A force-push on PR #${number} no longer names the head it replaced.`);
      return oid;
    });
  }

  async commitsAbove(base: string, head: string): Promise<string[]> {
    const out = await runGh(['api', `repos/${this.repo}/compare/${encodeURIComponent(base)}...${head}`, '--paginate', '--jq', '.commits[].sha']);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  async branchHead(branch: string): Promise<string> {
    return (await runGh(['api', `repos/${this.repo}/commits/${branch}`, '--jq', '.sha'])).trim();
  }


  async runsForCommit(branch: string, sha: string): Promise<Array<WorkflowRun & { workflow: string }>> {
    const query = `branch=${encodeURIComponent(branch)}&head_sha=${encodeURIComponent(sha)}&per_page=100`;
    const out = await runGh([
      'api', `repos/${this.repo}/actions/runs?${query}`, '--paginate', '--jq',
      '{total_count, runs: [.workflow_runs[] | {id, status, conclusion, headSha: .head_sha, workflow: .name, runAttempt: .run_attempt, attemptStartedAt: .run_started_at}]}',
    ]);
    const pages = jsonLines(out) as Array<{ total_count: number; runs: Array<WorkflowRun & { workflow: string }> }>;
    if (pages.length === 0) throw new Error('Workflow history is unavailable: GitHub returned no page.');
    const total = pages[0]?.total_count;
    if (!Number.isSafeInteger(total) || total! < 0 || pages.some((p) => p.total_count !== total || !Array.isArray(p.runs))) {
      throw new Error(`Workflow history for ${branch} at ${sha} has an invalid or inconsistent page count.`);
    }
    const runs = [...new Map(pages.flatMap((p) => p.runs).map((r) => [r.id, r])).values()];
    // GitHub bounds filtered history too. A paginated read must account for its
    // reported total, rather than turn an invisible run into a confirmed absence.
    if (runs.length !== total) throw new Error(`Workflow history is incomplete: read ${runs.length} of ${total} runs for ${branch} at ${sha}.`);
    if (runs.some((r) => !Number.isSafeInteger(r.id) || r.headSha !== sha || !Number.isSafeInteger(r.runAttempt)
      || r.runAttempt! < 1 || !r.attemptStartedAt || !Number.isFinite(Date.parse(r.attemptStartedAt)))) {
      throw new Error(`Workflow history for ${branch} at ${sha} has an invalid run identity; deployment is not confirmed.`);
    }
    return runs.sort((a, b) => Date.parse(b.attemptStartedAt!) - Date.parse(a.attemptStartedAt!) || b.id - a.id || b.runAttempt! - a.runAttempt!);
  }

  async runJobs(runId: number): Promise<Array<{ name: string; conclusion: string | null }>> {
    const out = await runGh(['api', `repos/${this.repo}/actions/runs/${runId}/jobs`, '--paginate', '--jq', '.jobs[] | {name, conclusion}']);
    return jsonLines(out) as Array<{ name: string; conclusion: string | null }>;
  }

  async createComment(number: number, body: string): Promise<number> {
    const out = await runGh(['api', '-X', 'POST', `repos/${this.repo}/issues/${number}/comments`, '--input', '-', '--jq', '.id'],
      JSON.stringify({ body }));
    return Number(out.trim());
  }

  async updateComment(id: number, body: string): Promise<void> {
    await runGh(['api', '-X', 'PATCH', `repos/${this.repo}/issues/comments/${id}`, '--input', '-', '--jq', '.id'], JSON.stringify({ body }));
  }

  async deleteComment(id: number): Promise<void> {
    await runGh(['api', '-X', 'DELETE', `repos/${this.repo}/issues/comments/${id}`]);
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<number> {
    const out = await runGh(['api', '-X', 'POST', `repos/${this.repo}/issues`, '--input', '-', '--jq', '.number'],
      JSON.stringify(input));
    return Number(out.trim());
  }

  async updateIssueBody(number: number, body: string): Promise<void> {
    await runGh(['api', '-X', 'PATCH', `repos/${this.repo}/issues/${number}`, '--input', '-', '--jq', '.number'], JSON.stringify({ body }));
  }

  async createPull(input: { base: string; head: string; title: string; body: string }): Promise<number> {
    const out = await runGh(['api', '-X', 'POST', `repos/${this.repo}/pulls`, '--input', '-', '--jq', '.number'], JSON.stringify(input));
    return Number(out.trim());
  }

  async updatePullBody(number: number, body: string): Promise<void> {
    await runGh(['api', '-X', 'PATCH', `repos/${this.repo}/pulls/${number}`, '--input', '-', '--jq', '.number'], JSON.stringify({ body }));
  }

  async addLabel(number: number, label: string): Promise<void> {
    assertApplicable(label);
    const apply = (): Promise<string> => runGh(
      ['api', '-X', 'POST', `repos/${this.repo}/issues/${number}/labels`, '--input', '-'],
      JSON.stringify({ labels: [label] }),
    );
    try {
      await apply();
    } catch (e) {
      // A repository that has never seen this label answers 422. The loop owns
      // every label it applies, so it can make the missing one and carry on
      // rather than needing a person to prepare each repository by hand.
      // Matched on 422 alone: a 404 here means the pull request is gone, which
      // is a real failure and not something creating a label would mend.
      if (!/\b422\b/.test(String(e))) throw e;
      await this.createLabel(label);
      await apply();
    }
  }

  private async createLabel(label: string): Promise<void> {
    const { color, description } = statusLabelDefinition(label);
    try {
      await runGh(['api', '-X', 'POST', `repos/${this.repo}/labels`, '--input', '-'],
        JSON.stringify({ name: label, color, description }));
    } catch (e) {
      // Two passes can reach a missing label together; whichever loses the race
      // wanted it to exist, and it does.
      if (!/already_exists|already exists/i.test(String(e))) throw e;
    }
  }

  async removeLabel(number: number, label: string): Promise<void> {
    assertRemovable(label);
    try {
      await runGh(['api', '-X', 'DELETE', `repos/${this.repo}/issues/${number}/labels/${encodeURIComponent(label)}`]);
    } catch (e) {
      // GitHub says exactly this when the label is not on the item: the caller
      // asked for it gone and it is gone. A bare 404 is not enough to go on —
      // a deleted pull request answers 404 too, and that is a real failure.
      if (!/Label does not exist/i.test(String(e))) throw e;
    }
  }

  async mergePull(number: number, expectedHead: string, bases: { into: string; never: string }): Promise<void> {
    // Read from GitHub, not taken from the caller: whatever the stage believed,
    // a pull request into the release branch is never merged from here.
    const base = (await runGh(['pr', 'view', String(number), '--repo', this.repo, '--json', 'baseRefName', '--jq', '.baseRefName'])).trim();
    if (base === bases.never) throw new Error(`Refusing to merge PR #${number}: its base is ${base}, the release branch, which only a person merges into.`);
    if (base !== bases.into) throw new Error(`Refusing to merge PR #${number}: its base is ${base}, not ${bases.into}.`);
    // `--match-head-commit` makes GitHub refuse if anything was pushed after the
    // loop read the head its conditions were checked against.
    await runGh(['pr', 'merge', String(number), '--repo', this.repo, '--merge', '--match-head-commit', expectedHead]);
  }

  async addLabels(number: number, labels: string[]): Promise<void> {
    await runGh(['api', '-X', 'POST', `repos/${this.repo}/issues/${number}/labels`, '--input', '-', '--jq', 'length'], JSON.stringify({ labels }));
  }

  async removeOperatorLabel(number: number, label: string): Promise<void> {
    await runGh(['api', '-X', 'DELETE', `repos/${this.repo}/issues/${number}/labels/${encodeURIComponent(label)}`, '--jq', 'length']);
  }

  async closeIssue(number: number, reason: 'completed' | 'not planned' = 'completed'): Promise<void> {
    await runGh(['api', '-X', 'PATCH', `repos/${this.repo}/issues/${number}`, '--input', '-', '--jq', '.state'],
      JSON.stringify({ state: 'closed', state_reason: reason === 'completed' ? 'completed' : 'not_planned' }));
  }

  async removeAssignees(number: number, logins: string[]): Promise<void> {
    await runGh(['api', '-X', 'DELETE', `repos/${this.repo}/issues/${number}/assignees`, '--input', '-', '--jq', '.number'], JSON.stringify({ assignees: logins }));
  }
}

/**
 * A store that reads through to a real one and refuses every write.
 *
 * What a dry run is handed. A stage that tried to write in a dry run fails loudly
 * rather than writing, so "writes nothing" is enforced, not merely intended.
 */
export class ReadOnlyStore implements Store {
  constructor(private readonly inner: StoreReader) {}
  get repo(): string { return this.inner.repo; }
  listOpenIssues(): Promise<Issue[]> { return this.inner.listOpenIssues(); }
  issue(n: number): Promise<Issue | undefined> { return this.inner.issue(n); }
  issueState(n: number): Promise<'OPEN' | 'CLOSED' | 'UNKNOWN'> { return this.inner.issueState(n); }
  comments(n: number): Promise<Comment[]> { return this.inner.comments(n); }
  labelActor(n: number, label: string): Promise<string | undefined> { return this.inner.labelActor(n, label); }
  reviewThreads(n: number): Promise<ReviewThread[]> { return this.inner.reviewThreads(n); }
  listOpenPulls(): Promise<PullRequest[]> { return this.inner.listOpenPulls(); }
  pullsFromHead(b: string): Promise<PullRequest[]> { return this.inner.pullsFromHead(b); }
  mergedPulls(base: string, head?: string, since?: string): Promise<PullRequest[]> { return this.inner.mergedPulls(base, head, since); }
  openPulls(base: string, head: string): Promise<PullRequest[]> { return this.inner.openPulls(base, head); }
  pullCommits(n: number): Promise<PullCommit[]> { return this.inner.pullCommits(n); }
  replacedPullHeads(n: number): Promise<string[]> { return this.inner.replacedPullHeads(n); }
  commitsAbove(base: string, head: string): Promise<string[]> { return this.inner.commitsAbove(base, head); }
  branchHead(b: string): Promise<string> { return this.inner.branchHead(b); }
  runsForCommit(b: string, sha: string): Promise<Array<WorkflowRun & { workflow: string }>> { return this.inner.runsForCommit(b, sha); }
  runJobs(id: number): Promise<Array<{ name: string; conclusion: string | null }>> { return this.inner.runJobs(id); }
  private refuse(what: string): Promise<never> {
    return Promise.reject(new Error(`A dry run may not ${what}.`));
  }
  createComment(): Promise<number> { return this.refuse('create a comment'); }
  updateComment(): Promise<void> { return this.refuse('update a comment'); }
  deleteComment(): Promise<void> { return this.refuse('delete a comment'); }
  createIssue(): Promise<number> { return this.refuse('open an issue'); }
  updateIssueBody(): Promise<void> { return this.refuse('edit an issue'); }
  createPull(): Promise<number> { return this.refuse('open a pull request'); }
  updatePullBody(): Promise<void> { return this.refuse('edit a pull request'); }
  mergePull(): Promise<void> { return this.refuse('merge'); }
  addLabels(): Promise<void> { return this.refuse('add a label'); }
  removeOperatorLabel(): Promise<void> { return this.refuse('remove an operator label'); }
  addLabel(): Promise<void> { return this.refuse('apply a label'); }
  removeLabel(): Promise<void> { return this.refuse('remove a label'); }
  closeIssue(): Promise<void> { return this.refuse('close an issue'); }
  removeAssignees(): Promise<void> { return this.refuse('unassign anyone'); }
}
