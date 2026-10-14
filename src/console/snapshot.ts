import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runGh } from '../loop/github.js';
import type { Comment } from '../loop/github.js';

/**
 * What the console knows about the target store, read from GitHub in one go.
 *
 * Everything the board and the derived verdicts need comes from here and from
 * the coordinator's own records; nothing is stored between refreshes except the
 * last snapshot that was read successfully, kept so a failed read can show it
 * with its age instead of an empty board.
 */

export interface LabelEvent {
  type: 'labeled' | 'unlabeled';
  label: string;
  actor: string;
  at: string;
}

export interface CloseEvent {
  actor: string;
  at: string;
  /** GitHub's `stateReason`: `COMPLETED`, `NOT_PLANNED`, `DUPLICATE`, or empty for an older close. */
  reason: string;
}

export interface BodyEdit {
  at: string;
  editor: string;
}

export interface IssueFact {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  assignees: string[];
  body: string;
  createdAt?: string;
  updatedAt?: string;
  /** Label changes, oldest first. */
  events: LabelEvent[];
  closes: CloseEvent[];
  /** Edits to the body, oldest first. */
  edits: BodyEdit[];
  comments: Comment[];
}

export type CheckState = 'success' | 'failure' | 'pending' | 'none';

export interface PullFact {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  /** Current PR description, needed to bind operator-attested repairs to what was reviewed. */
  body?: string;
  /** The base commit GitHub diffs the pull request against; kept after a merge. */
  baseRefOid?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Labels on the pull request, when the store snapshot carries them. */
  labels?: string[];
  isDraft: boolean;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergedAt?: string;
  mergedBy?: string;
  /** Combined check state of the head commit. */
  checks: CheckState;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /** The head commit's message, for the author family. */
  headMessage: string;
  comments: Comment[];
}

export interface StoreSnapshot {
  repo: string;
  takenAt: string;
  /** Open issues. */
  issues: IssueFact[];
  /** Open pull requests. */
  pulls: PullFact[];
  /** Closed issues and merged or closed pull requests the coordinator's records name. */
  referencedIssues: IssueFact[];
  referencedPulls: PullFact[];
}

/** A read of the store, with the numbers of closed items worth reading too. */
export interface SnapshotSource {
  read(referenced: { issues: number[]; pulls: number[] }): Promise<StoreSnapshot>;
}

/* ------------------------------------------------------------------ GitHub */

const ISSUE_FIELDS = `
  number title body state createdAt updatedAt
  labels(first: 50) { nodes { name } }
  assignees(first: 10) { nodes { login } }
  timelineItems(last: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, CLOSED_EVENT]) {
    nodes {
      __typename
      ... on LabeledEvent { createdAt actor { login } label { name } }
      ... on UnlabeledEvent { createdAt actor { login } label { name } }
      ... on ClosedEvent { createdAt actor { login } stateReason }
    }
  }
  userContentEdits(last: 30) { nodes { editedAt editor { login } } }
  comments(last: 60) { nodes { databaseId body author { login } createdAt } }`;

const PULL_FIELDS = `
  number title body headRefName headRefOid baseRefName baseRefOid isDraft state mergedAt mergeable createdAt updatedAt
  labels(first: 50) { nodes { name } }
  mergedBy { login }
  commits(last: 1) { nodes { commit { message statusCheckRollup { state } } } }
  comments(last: 60) { nodes { databaseId body author { login } createdAt } }`;

type Raw = Record<string, unknown>;
const nodes = (v: unknown): Raw[] => (((v as { nodes?: unknown[] } | null)?.nodes ?? []) as Raw[]).filter((n) => n !== null);
const login = (v: unknown): string => String((v as { login?: string } | null)?.login ?? 'ghost');

function toComments(v: unknown): Comment[] {
  return nodes(v).map((c) => ({ id: Number(c['databaseId']), body: String(c['body'] ?? ''), author: login(c['author']), createdAt: String(c['createdAt'] ?? '') }));
}

export function toIssueFact(raw: Raw): IssueFact {
  const events: LabelEvent[] = [];
  const closes: CloseEvent[] = [];
  for (const e of nodes(raw['timelineItems'])) {
    const at = String(e['createdAt'] ?? '');
    if (e['__typename'] === 'ClosedEvent') closes.push({ actor: login(e['actor']), at, reason: String(e['stateReason'] ?? '') });
    else events.push({
      type: e['__typename'] === 'LabeledEvent' ? 'labeled' : 'unlabeled',
      label: String((e['label'] as { name?: string } | null)?.name ?? ''),
      actor: login(e['actor']),
      at,
    });
  }
  return {
    number: Number(raw['number']),
    title: String(raw['title'] ?? ''),
    state: String(raw['state']).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
    labels: nodes(raw['labels']).map((l) => String(l['name'] ?? '')),
    assignees: nodes(raw['assignees']).map((a) => login(a)),
    body: String(raw['body'] ?? ''),
    ...(typeof raw['createdAt'] === 'string' ? { createdAt: raw['createdAt'] } : {}),
    ...(typeof raw['updatedAt'] === 'string' ? { updatedAt: raw['updatedAt'] } : {}),
    events,
    closes,
    edits: nodes(raw['userContentEdits']).map((e) => ({ at: String(e['editedAt'] ?? ''), editor: login(e['editor']) })).sort((a, b) => a.at.localeCompare(b.at)),
    comments: toComments(raw['comments']),
  };
}

export function toPullFact(raw: Raw): PullFact {
  const commit = nodes(raw['commits'])[0]?.['commit'] as Raw | undefined;
  const rollup = String((commit?.['statusCheckRollup'] as { state?: string } | null)?.state ?? '').toUpperCase();
  const checks: CheckState = rollup === 'SUCCESS' ? 'success'
    : rollup === 'FAILURE' || rollup === 'ERROR' ? 'failure'
      : rollup === 'PENDING' || rollup === 'EXPECTED' ? 'pending' : 'none';
  const state = String(raw['state']).toUpperCase();
  const mergeable = String(raw['mergeable'] ?? '').toUpperCase();
  return {
    number: Number(raw['number']),
    title: String(raw['title'] ?? ''),
    headRefName: String(raw['headRefName'] ?? ''),
    headRefOid: String(raw['headRefOid'] ?? ''),
    body: String(raw['body'] ?? ''),
    baseRefName: String(raw['baseRefName'] ?? ''),
    ...(typeof raw['baseRefOid'] === 'string' ? { baseRefOid: raw['baseRefOid'] } : {}),
    labels: nodes(raw['labels']).map((l) => String(l['name'] ?? '')),
    ...(typeof raw['createdAt'] === 'string' ? { createdAt: raw['createdAt'] } : {}),
    ...(typeof raw['updatedAt'] === 'string' ? { updatedAt: raw['updatedAt'] } : {}),
    isDraft: raw['isDraft'] === true,
    state: state === 'MERGED' ? 'MERGED' : state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    ...(typeof raw['mergedAt'] === 'string' ? { mergedAt: raw['mergedAt'] } : {}),
    ...(raw['mergedBy'] ? { mergedBy: login(raw['mergedBy']) } : {}),
    checks,
    mergeable: mergeable === 'MERGEABLE' ? 'MERGEABLE' : mergeable === 'CONFLICTING' ? 'CONFLICTING' : 'UNKNOWN',
    headMessage: String(commit?.['message'] ?? ''),
    comments: toComments(raw['comments']),
  };
}

type Gql = (query: string, variables: Record<string, string>) => Promise<Raw>;

const ghGraphql: Gql = async (query, variables) => {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(variables)) args.push('-F', `${k}=${v}`);
  const parsed = JSON.parse(await runGh(args)) as { data?: Raw; errors?: Array<{ message?: string }> };
  if (parsed.errors?.length) throw new Error(`GitHub GraphQL: ${parsed.errors.map((e) => e.message).join('; ')}`);
  return parsed.data ?? {};
};

/** Reads the store through the operator's `gh` login: paged open items, then the named closed ones in one query. */
export class GhSnapshotSource implements SnapshotSource {
  constructor(readonly repo: string, private readonly gql: Gql = ghGraphql, private readonly now: () => Date = () => new Date()) {}

  async read(referenced: { issues: number[]; pulls: number[] }): Promise<StoreSnapshot> {
    const [owner, name] = this.repo.split('/') as [string, string];
    const issues = await this.paged('issues', ISSUE_FIELDS, owner, name);
    const pulls = await this.paged('pullRequests', PULL_FIELDS, owner, name);
    const openIssues = new Set(issues.map((i) => Number(i['number'])));
    const openPulls = new Set(pulls.map((p) => Number(p['number'])));
    let wantIssues = [...new Set(referenced.issues)].filter((n) => !openIssues.has(n) && !openPulls.has(n));
    let wantPulls = [...new Set(referenced.pulls)].filter((n) => !openPulls.has(n));
    // One aliased query for every closed item a record names, and for the closed
    // pull requests from each open ticket's `ticket/<n>` branch — a claimed ticket
    // whose pull request merged is waiting on a person to close it. An issue number
    // that is really a pull request comes back null from `issue(number:)` and is dropped.
    const query = (): string => {
      const parts = [
        ...wantIssues.map((n) => `i${n}: issue(number: ${n}) { ${ISSUE_FIELDS} }`),
        ...wantPulls.map((n) => `p${n}: pullRequest(number: ${n}) { ${PULL_FIELDS} }`),
        ...[...openIssues].map((n) => `t${n}: pullRequests(headRefName: "ticket/${n}", states: [MERGED, CLOSED], last: 5) { nodes { ${PULL_FIELDS} } }`),
      ];
      return parts.length === 0 ? '' : `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${parts.join('\n')} } }`;
    };
    // A number a record names that GitHub has no such item for — a deleted issue,
    // a pull request number that was an issue — fails the whole query, and the error
    // names only some of them. Drop those named and ask again, until none is left;
    // any other error is a failed read.
    let data: Raw = {};
    for (;;) {
      try {
        data = query() ? await this.gql(query(), { owner, name }) : {};
        break;
      } catch (err) {
        const missing = (kind: string): Set<number> => new Set([...String(err instanceof Error ? err.message : err)
          .matchAll(new RegExp(`Could not resolve to an? ${kind} with the number of (\\d+)`, 'g'))].map((m) => Number(m[1])));
        const gonePulls = missing('PullRequest');
        const goneIssues = missing('Issue');
        const before = wantPulls.length + wantIssues.length;
        wantPulls = wantPulls.filter((n) => !gonePulls.has(n));
        wantIssues = wantIssues.filter((n) => !goneIssues.has(n));
        if (wantPulls.length + wantIssues.length === before) throw err;
      }
    }
    const repo = (data['repository'] ?? {}) as Record<string, Raw | null>;
    const refIssues = wantIssues.map((n) => repo[`i${n}`]).filter((r): r is Raw => r != null).map(toIssueFact);
    const refPulls = [
      ...wantPulls.map((n) => repo[`p${n}`]).filter((r): r is Raw => r != null),
      ...[...openIssues].flatMap((n) => nodes(repo[`t${n}`])),
    ].map(toPullFact).filter((p, i, all) => all.findIndex((q) => q.number === p.number) === i);
    return {
      repo: this.repo,
      takenAt: this.now().toISOString(),
      issues: issues.map(toIssueFact),
      pulls: pulls.map(toPullFact),
      referencedIssues: refIssues,
      referencedPulls: refPulls,
    };
  }

  private async paged(field: 'issues' | 'pullRequests', fields: string, owner: string, name: string): Promise<Raw[]> {
    const out: Raw[] = [];
    let cursor: string | undefined;
    // Twenty pages is 1,000 open issues or 600 open pull requests; a store larger than that is not one the board can show whole.
    for (let page = 0; page < 20; page++) {
      const after = cursor ? ', after: $cursor' : '';
      const query = `query($owner: String!, $name: String!${cursor ? ', $cursor: String!' : ''}) { repository(owner: $owner, name: $name) {
        ${field}(states: OPEN, first: ${field === 'issues' ? 50 : 30}${after}) { pageInfo { hasNextPage endCursor } nodes { ${fields} } } } }`;
      const data = await this.gql(query, { owner, name, ...(cursor ? { cursor } : {}) });
      const conn = ((data['repository'] as Raw | undefined)?.[field] ?? {}) as { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: Raw[] };
      out.push(...(conn.nodes ?? []).filter((n) => n !== null));
      if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) return out;
      cursor = conn.pageInfo.endCursor;
    }
    throw new Error(`More than twenty pages of open ${field}; the snapshot would be partial.`);
  }
}

/* ------------------------------------------------------------------ last good */

export interface SnapshotRead {
  snapshot?: StoreSnapshot;
  /** Set when this refresh failed and `snapshot` is the last good one, or none exists. */
  stale?: { error: string; ageSeconds?: number; failedAt: string };
}

/**
 * Keeps the last snapshot that was read successfully, on disk, so a failed read
 * — GitHub down, `gh` logged out, a rate limit — shows that snapshot with its age
 * and the error rather than an empty board, and a restarted console still has it.
 */
export class LastGoodSnapshot {
  constructor(private readonly source: SnapshotSource, private readonly path: string, private readonly now: () => Date = () => new Date()) {}

  async refresh(referenced: { issues: number[]; pulls: number[] }): Promise<SnapshotRead> {
    try {
      const snapshot = await this.source.read(referenced);
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(`${this.path}.tmp`, JSON.stringify(snapshot), 'utf8');
      renameSync(`${this.path}.tmp`, this.path);
      return { snapshot };
    } catch (err) {
      const previous = this.last();
      const failedAt = this.now().toISOString();
      const error = err instanceof Error ? err.message : String(err);
      return previous
        ? { snapshot: previous, stale: { error, failedAt, ageSeconds: Math.max(0, Math.round((this.now().getTime() - Date.parse(previous.takenAt)) / 1000)) } }
        : { stale: { error, failedAt } };
    }
  }

  last(): StoreSnapshot | undefined {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as StoreSnapshot;
    } catch {
      return undefined;
    }
  }
}
