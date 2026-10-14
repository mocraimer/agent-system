import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureStoreConfig, SHA } from '../dist/loop/testkit.js';
import {
  card, claim, comment, FIXTURE_SLUG, fixtureTargetRepo, issue, proposal, pull, review, writeStoreFile,
} from '../dist/console/testkit.js';
import { renderFaultMarker } from '../dist/loop/markers.js';
import type { StoreSnapshot } from '../src/console/snapshot.js';
import type { PassReport } from '../src/loop/supervisor.js';
import type { Scorecard } from '../src/eval/scorecard.js';

/**
 * Fixture state for the console: a target repository on disk, a store file in
 * place of GitHub, the loop's last pass and scorecards in a coordinator state
 * directory. Titles and counts are sized like a real store's, not placeholders.
 */

export const OPERATOR = 'octocat';
export const STORE_CONFIG = fixtureStoreConfig({
  typeRows: ['| `type:bug` | 4 |', '| `type:chore` | 5 |'], defaultRung: 4,
  // Shape lists both families, as a real policy often does; the other stages keep one row.
  stageRows: [
    '| shape | claude-local | model-shape | low | 1 | 1 |',
    '| shape | pi-local | model-gpt | high | 0 | 1 |',
    '| assess | claude-local | model-assess | low | 1 | 1 |',
    '| sweep | claude-local | model-sweep | low | 1 | 1 |',
    '| fix | claude-local | model-fix | low | 1 | 1 |',
    '| check | claude-local | model-check | low | 1 | 1 |',
  ],
});

const LONG_TITLES = [
  'Sync: when two devices edit the same collection offline, merge both sets of changes instead of keeping only the last one to reconnect',
  'Importer: read bookmark files that nest folders more than eight levels deep',
  'Reader view: honour the system font size on Android tablets',
  'Search: rank an exact title match above a body match',
  'Tags: let a reader rename a tag without retagging every article by hand',
  'Offline: show which saved articles are available without a connection',
  'docs: explain how the extension decides what counts as the article body',
  'Shortcuts: j and k move between articles in the list, and o opens one',
  'Export: write highlights to Markdown with the article link above each group',
  'Dark theme: code blocks in saved articles lose their contrast',
  'Feeds: subscribe to a site from its article page in one click',
  'Archive: keep an article’s reading position when it is archived and restored',
  'Sharing: a read-only link to one collection, revocable by its owner',
  'First run: import the browser’s own reading list',
  'Content: a “Why is this page blank in reader view?” help page',
  'test: cover the list virtualisation with 10,000 articles',
  'Bug: a renamed collection keeps its old name in the sidebar until reload',
  'Digest: let a reader pick the weekday the weekly digest arrives',
  'Larkspur as an assistant connector: an MCP server for saving, searching and tagging articles',
  'Tech debt: move the mobile app off the deprecated navigation library before the next major upgrade',
];

export function populatedStore(): StoreSnapshot {
  const issues = LONG_TITLES.map((title, i) => {
    const body = `Body of ticket ${300 + i}.`;
    return issue(300 + i, { title, body, labels: i % 3 === 0 ? ['type:bug'] : ['type:chore'], comments: [proposal(body)] });
  });
  issues.push(
    issue(623, { title: 'Write down which branch each surface ships from', labels: ['shaped', 'effort:backlog', 'type:docs'], events: [{ type: 'labeled', label: 'shaped', actor: OPERATOR, at: '2026-09-08T04:18:35Z' }] }),
    issue(636, { title: 'api pins an older markdown parser than the web app', labels: ['auto', 'shaped', 'effort:backlog'], comments: [claim()] }),
    issue(640, { title: 'Launch: the reading list, collections and the extension', labels: ['effort', 'effort:backlog'] }),
    issue(652, { title: 'Escalated: run-ticket could not reproduce the failing sync test', labels: ['escalated', 'shaped', 'auto', 'effort:backlog'], events: [{ type: 'labeled', label: 'escalated', actor: OPERATOR, at: '2026-09-17T09:12:00Z' }] }),
    issue(660, { title: 'Hand-held migration of the sync queue', labels: ['shaped'], assignees: ['someone-else'] }),
    issue(690, { title: '[loop] sweep stalled: sweep stage', body: `${renderFaultMarker('ab'.repeat(16))}\nThe sweep stage waited two passes.` }),
    issue(671, { title: 'Collections: drag an article between two collections' }),
  );
  const head = SHA('head-701');
  const clean = SHA('head-702');
  return {
    repo: FIXTURE_SLUG,
    takenAt: new Date().toISOString(),
    issues,
    pulls: [
      pull(679, { title: 'fix(sync): keep the newer edit when two devices save at once (#611)', headRefName: 'ticket/611', headRefOid: head, comments: [review(head, 3)] }),
      pull(686, { title: 'fix(import): skip duplicate bookmarks when a file is imported twice (#621)', headRefName: 'ticket/621' }),
      pull(691, { title: 'fix(limits): count a saved article once when it is saved twice (#610)', headRefName: 'ticket/610', checks: 'failure' }),
      pull(702, { title: 'chore(deps): drop the unused lodash.merge pin', headRefName: 'ticket/302', headRefOid: clean, comments: [review(clean, 0)] }),
      pull(703, { title: 'fix(extension): keep the popup open when a page has no text', headRefName: 'ticket/300', headRefOid: clean, comments: [review(clean, 0)] }),
    ],
    referencedIssues: [],
    referencedPulls: [],
  };
}

export function emptyStore(): StoreSnapshot {
  return { repo: FIXTURE_SLUG, takenAt: new Date().toISOString(), issues: [], pulls: [], referencedIssues: [], referencedPulls: [] };
}

export function lastPass(classification: PassReport['classification'], because: string): PassReport {
  const now = new Date(Date.now() - 4 * 60_000).toISOString();
  return { passId: 'pass_fixture0001', repo: FIXTURE_SLUG, dryRun: false, startedAt: now, endedAt: now, classification, because, stages: [], faults: [] };
}

export interface ConsoleFixture {
  root: string;
  state: string;
  repo: string;
  storeFile: string;
}

/** Lay out a fixture under `root`: target repo, store file, coordinator state with an operator. */
export function consoleFixture(root: string, store: StoreSnapshot, pass: PassReport | undefined, cards: Scorecard[] = []): ConsoleFixture {
  const { path: repo } = fixtureTargetRepo(root, STORE_CONFIG);
  const state = join(root, 'state');
  const storeFile = join(root, 'store.json');
  writeStoreFile(storeFile, store, OPERATOR);
  execFileSync(process.execPath, ['dist/cli/main.js', 'init', '--operator', OPERATOR], { env: { ...process.env, AGENTSYS_STATE: state } });
  execFileSync(process.execPath, ['dist/cli/main.js', 'floor', '--repo', FIXTURE_SLUG, '--pr-base', 'dev', '--as', OPERATOR], { env: { ...process.env, AGENTSYS_STATE: state } });
  if (pass) {
    const dir = join(state, 'loop', FIXTURE_SLUG.replace(/[^A-Za-z0-9._-]+/g, '_'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ repo: FIXTURE_SLUG, passes: 17, streaks: {}, faults: {}, lastPass: pass }));
  }
  mkdirSync(join(state, 'scorecards'), { recursive: true });
  for (const c of cards) writeFileSync(join(state, 'scorecards', `${c.id}.json`), JSON.stringify(c));
  return { root, state, repo, storeFile };
}

export function fixtureCards(): Scorecard[] {
  return [
    card('card_loop-shape-318-aa', { stage: 'shape', item: '#318', workType: 'chore', wrote: 'comment 1' }, {
      settings: { requested: { model: 'claude-opus-5-5', effort: 'medium' }, resolved: { model: 'claude-opus-5-5', effort: 'medium' }, observed: { model: 'claude-opus-5-5', effort: 'medium' }, prompt: { template: 'shape', digest: 'c0ffee'.repeat(10) + 'abcd' } },
    }),
    card('card_loop-review-pr679-aa', { stage: 'review', item: 'PR #679', workType: 'bug', head: SHA('head-701'), findings: 3, independent: true }),
  ];
}

/** Start `agentsys ui` — the real entry point — against a fixture, and return its bootstrap URL. */
export async function startConsole(f: ConsoleFixture, extraEnv: Record<string, string> = {}): Promise<{ url: string; child: ChildProcessWithoutNullStreams }> {
  const child = spawn(process.execPath, ['dist/cli/main.js', 'ui', '--repo', f.repo, '--store-file', f.storeFile], {
    cwd: process.cwd(), env: { ...process.env, AGENTSYS_STATE: f.state, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`UI server did not print a URL. Output: ${output}`)), 20_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const match = /Agent system UI listening at (http:\/\/127\.0\.0\.1:\d+\/#bootstrap=[^\s]+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]!); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c: Buffer) => { output += c.toString('utf8'); });
    child.once('exit', (code) => { if (code !== 0) reject(new Error(`UI server exited ${code}: ${output}`)); });
  });
  return { url, child };
}

export { comment };
