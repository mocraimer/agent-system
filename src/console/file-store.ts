import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Comment, Issue, PullCommit, PullRequest, ReviewThread, Store, WorkflowRun } from '../loop/github.js';
import { assertApplicable, assertRemovable } from '../loop/labels.js';
import type { IssueFact, PullFact, SnapshotSource, StoreSnapshot } from './snapshot.js';

/**
 * A ticket store kept in one JSON file: a snapshot the console reads, and the
 * writes the console and the loop's stages make applied back to it.
 *
 * For running the console against fixture state — the browser journey, a design
 * review with twenty proposals and a stalled stage — where talking to GitHub is
 * exactly what must not happen. Every write is also appended to `writes`, so a
 * test can assert the label call it expected. `failRead` makes the next reads
 * fail, to show the stale state.
 */
export interface StoreFile extends StoreSnapshot {
  /** Who the file's writes are made as. */
  login: string;
  writes: Array<{ kind: string; target: number; detail?: string; at: string }>;
  failRead?: string;
  nextId?: number;
}

export class FileStore implements Store, SnapshotSource {
  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {}

  get repo(): string { return this.load().repo; }

  private load(): StoreFile {
    return JSON.parse(readFileSync(this.path, 'utf8')) as StoreFile;
  }

  private save(file: StoreFile): void {
    writeFileSync(`${this.path}.tmp`, JSON.stringify(file, null, 2), 'utf8');
    renameSync(`${this.path}.tmp`, this.path);
  }

  private write<T>(kind: string, target: number, detail: string | undefined, change: (file: StoreFile) => T): Promise<T> {
    const file = this.load();
    const out = change(file);
    file.writes = [...(file.writes ?? []), { kind, target, ...(detail !== undefined ? { detail } : {}), at: this.now().toISOString() }];
    this.save(file);
    return Promise.resolve(out);
  }

  private nextId(file: StoreFile): number {
    file.nextId = (file.nextId ?? 900_000) + 1;
    return file.nextId;
  }

  read(): Promise<StoreSnapshot> {
    const file = this.load();
    if (file.failRead) return Promise.reject(new Error(file.failRead));
    const { login: _login, writes: _writes, failRead: _fail, nextId: _next, ...snapshot } = file;
    return Promise.resolve({ ...snapshot, takenAt: this.now().toISOString() });
  }

  /* ------------------------------------------------------------ reads */

  private allIssues(f: StoreFile): IssueFact[] { return [...f.issues, ...f.referencedIssues]; }
  private allPulls(f: StoreFile): PullFact[] { return [...f.pulls, ...f.referencedPulls]; }

  private static toIssue(i: IssueFact): Issue {
    return { number: i.number, title: i.title, state: i.state, updatedAt: '', labels: i.labels, assignees: i.assignees, body: i.body };
  }

  private static toPull(p: PullFact): PullRequest {
    return {
      number: p.number, title: p.title, headRefName: p.headRefName, headRefOid: p.headRefOid, baseRefName: p.baseRefName,
      isDraft: p.isDraft, body: '', author: '', labels: p.labels ?? [], state: p.state, mergedAt: p.mergedAt ?? null,
    };
  }

  listOpenIssues(): Promise<Issue[]> { return Promise.resolve(this.load().issues.map(FileStore.toIssue)); }
  issue(n: number): Promise<Issue | undefined> {
    const found = this.allIssues(this.load()).find((i) => i.number === n);
    return Promise.resolve(found ? FileStore.toIssue(found) : undefined);
  }
  async issueState(n: number): Promise<'OPEN' | 'CLOSED' | 'UNKNOWN'> { return (await this.issue(n))?.state as 'OPEN' | 'CLOSED' | undefined ?? 'UNKNOWN'; }
  comments(n: number): Promise<Comment[]> {
    const f = this.load();
    return Promise.resolve([...(this.allIssues(f).find((i) => i.number === n)?.comments ?? this.allPulls(f).find((p) => p.number === n)?.comments ?? [])]);
  }
  /** Only issues carry an event history in the store file, so a pull request's label applier reads as unknown. */
  labelActor(n: number, label: string): Promise<string | undefined> {
    const f = this.load();
    const item = this.allIssues(f).find((i) => i.number === n) ?? this.allPulls(f).find((p) => p.number === n);
    const events = item && 'events' in item && Array.isArray(item.events) ? item.events : [];
    return Promise.resolve([...events].reverse().find((e) => e.type === 'labeled' && e.label === label)?.actor || undefined);
  }
  reviewThreads(_n: number): Promise<ReviewThread[]> { return Promise.resolve([]); }
  listOpenPulls(): Promise<PullRequest[]> { return Promise.resolve(this.load().pulls.map(FileStore.toPull)); }
  pullsFromHead(branch: string): Promise<PullRequest[]> { return Promise.resolve(this.allPulls(this.load()).filter((p) => p.headRefName === branch).map(FileStore.toPull)); }
  mergedPulls(base: string, head?: string, since?: string): Promise<PullRequest[]> {
    return Promise.resolve(this.allPulls(this.load()).filter((p) => p.state === 'MERGED' && p.baseRefName === base && (!head || p.headRefName === head)
      && (!since || Date.parse(p.mergedAt ?? '') >= Date.parse(since.slice(0, 10)))).map(FileStore.toPull));
  }
  openPulls(base: string, head: string): Promise<PullRequest[]> {
    return Promise.resolve(this.load().pulls.filter((p) => p.baseRefName === base && p.headRefName === head).map(FileStore.toPull));
  }
  pullCommits(n: number): Promise<PullCommit[]> {
    const p = this.allPulls(this.load()).find((x) => x.number === n);
    return Promise.resolve(p ? [{ oid: p.headRefOid, message: p.headMessage }] : []);
  }
  replacedPullHeads(_n: number): Promise<string[]> { return Promise.resolve([]); }
  commitsAbove(_base: string, _head: string): Promise<string[]> { return Promise.resolve([]); }
  branchHead(branch: string): Promise<string> {
    const p = this.allPulls(this.load()).find((x) => x.headRefName === branch);
    return p ? Promise.resolve(p.headRefOid) : Promise.reject(new Error(`no branch ${branch} in the store file`));
  }
  runsForCommit(): Promise<Array<WorkflowRun & { workflow: string }>> { return Promise.resolve([]); }
  runJobs(): Promise<Array<{ name: string; conclusion: string | null }>> { return Promise.resolve([]); }

  /* ------------------------------------------------------------ writes */

  private target(f: StoreFile, n: number): IssueFact | PullFact {
    const found = this.allIssues(f).find((i) => i.number === n) ?? this.allPulls(f).find((p) => p.number === n);
    if (!found) throw new Error(`#${n} is not in the store file`);
    return found;
  }

  createComment(n: number, body: string): Promise<number> {
    return this.write('comment', n, body, (f) => {
      const id = this.nextId(f);
      this.target(f, n).comments.push({ id, body, author: f.login, createdAt: this.now().toISOString() });
      return id;
    });
  }
  updateComment(id: number, body: string): Promise<void> {
    return this.write('update-comment', id, body, (f) => {
      for (const item of [...this.allIssues(f), ...this.allPulls(f)]) for (const c of item.comments) if (c.id === id) c.body = body;
    });
  }
  deleteComment(id: number): Promise<void> {
    return this.write('delete-comment', id, undefined, (f) => {
      for (const item of [...this.allIssues(f), ...this.allPulls(f)]) item.comments = item.comments.filter((c) => c.id !== id);
    });
  }
  createIssue(input: { title: string; body: string; labels: string[] }): Promise<number> {
    return this.write('issue', 0, input.title, (f) => {
      const number = this.nextId(f);
      f.issues.push({ number, title: input.title, state: 'OPEN', labels: input.labels, assignees: [], body: input.body, events: [], closes: [], edits: [], comments: [] });
      return number;
    });
  }
  updateIssueBody(n: number, body: string): Promise<void> {
    return this.write('update-issue', n, undefined, (f) => {
      const issue = this.allIssues(f).find((i) => i.number === n);
      if (!issue) throw new Error(`#${n} is not in the store file`);
      issue.body = body;
      issue.edits.push({ at: this.now().toISOString(), editor: f.login });
    });
  }
  createPull(input: { base: string; head: string; title: string; body: string }): Promise<number> {
    return this.write('pull', 0, `${input.head} → ${input.base}`, (f) => {
      const number = this.nextId(f);
      f.pulls.push({ number, title: input.title, headRefName: input.head, headRefOid: '0'.repeat(40), baseRefName: input.base, isDraft: false, state: 'OPEN', checks: 'pending', mergeable: 'UNKNOWN', headMessage: '', comments: [] });
      return number;
    });
  }
  updatePullBody(n: number): Promise<void> { return this.write('update-pull', n, undefined, () => undefined); }
  mergePull(n: number, head: string): Promise<void> {
    return this.write('merge', n, head, (f) => {
      const i = f.pulls.findIndex((p) => p.number === n);
      if (i === -1) throw new Error(`PR #${n} is not open in the store file`);
      const [pr] = f.pulls.splice(i, 1);
      if (pr!.headRefOid !== head) throw new Error(`PR #${n} head is ${pr!.headRefOid}, not ${head}`);
      f.referencedPulls.push({ ...pr!, state: 'MERGED', mergedAt: this.now().toISOString(), mergedBy: f.login });
    });
  }
  addLabel(n: number, label: string): Promise<void> {
    assertApplicable(label);
    return this.write('add-label', n, label, (f) => {
      const item = this.allIssues(f).find((i) => i.number === n) ?? this.allPulls(f).find((p) => p.number === n);
      if (!item) throw new Error(`#${n} is not in the store file`);
      if (!item.labels) item.labels = [];
      if (!item.labels.includes(label)) item.labels.push(label);
      if ('events' in item) item.events.push({ type: 'labeled', label, actor: f.login, at: this.now().toISOString() });
    });
  }
  addLabels(n: number, labels: string[]): Promise<void> {
    return this.write('add-labels', n, labels.join(','), (f) => {
      const item = this.allIssues(f).find((i) => i.number === n) ?? this.allPulls(f).find((p) => p.number === n);
      if (!item) throw new Error(`#${n} is not in the store file`);
      if (!item.labels) item.labels = [];
      for (const label of labels) {
        if (!item.labels.includes(label)) item.labels.push(label);
        if ('events' in item) item.events.push({ type: 'labeled', label, actor: f.login, at: this.now().toISOString() });
      }
    });
  }
  removeLabel(n: number, label: string): Promise<void> {
    assertRemovable(label);
    return this.removeOperatorLabel(n, label);
  }
  removeOperatorLabel(n: number, label: string): Promise<void> {
    return this.write('remove-label', n, label, (f) => {
      const item = this.allIssues(f).find((i) => i.number === n) ?? this.allPulls(f).find((p) => p.number === n);
      if (!item) throw new Error(`#${n} is not in the store file`);
      item.labels = (item.labels ?? []).filter((l) => l !== label);
      if ('events' in item) item.events.push({ type: 'unlabeled', label, actor: f.login, at: this.now().toISOString() });
    });
  }
  closeIssue(n: number, reason: 'completed' | 'not planned' = 'completed'): Promise<void> {
    return this.write('close', n, reason, (f) => {
      const i = f.issues.findIndex((x) => x.number === n);
      if (i === -1) throw new Error(`#${n} is not open in the store file`);
      const [issue] = f.issues.splice(i, 1);
      f.referencedIssues.push({ ...issue!, state: 'CLOSED', closes: [...issue!.closes, { actor: f.login, at: this.now().toISOString(), reason: reason === 'completed' ? 'COMPLETED' : 'NOT_PLANNED' }] });
    });
  }
  removeAssignees(n: number, logins: string[]): Promise<void> {
    return this.write('unassign', n, logins.join(','), (f) => {
      const issue = this.allIssues(f).find((i) => i.number === n);
      if (!issue) throw new Error(`#${n} is not in the store file`);
      issue.assignees = issue.assignees.filter((a) => !logins.includes(a));
    });
  }
}
