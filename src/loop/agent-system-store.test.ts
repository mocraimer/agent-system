import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writeFloor } from '../core/floor.js';
import { sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import { renderReviewMarker } from './markers.js';
import { runPass } from './pass.js';
import { familyOf, parseStoreConfig, resolveStopLine, reviewTiersFor, stageOptions } from './policy.js';
import { improveSettings } from './stages/improve.js';
import { FakeCommands, FakeRepo, FakeStore, SHA } from './testkit.js';

/**
 * agent-system's own ticket store, as this repository ships it in
 * `tickets/store-config.md`. The fixture repository stands in for it, so these
 * passes run the loop against the real policy file.
 */
const STORE_CONFIG = readFileSync(fileURLToPath(new URL('../../tickets/store-config.md', import.meta.url)), 'utf8');
const SLUG = 'example-org/larkspur';

describe('agent-system\'s store configuration', () => {
  const policy = parseStoreConfig(STORE_CONFIG);

  it('names one branch, main, as both the base and the release branch, with no release checks', () => {
    assert.equal(policy.protocol.releaseBranch.value, 'main');
    assert.equal(policy.protocol.markerPrefix.value, 'agent-system');
    assert.equal(policy.protocol.deployWorkflow, undefined);
    assert.deepEqual(policy.protocol.releaseChecks, []);
    assert.equal(policy.limits.get('status home')?.value, 'effort:failure-handling');
  });

  it('stops every type at rung 4, and a type nobody listed too', () => {
    for (const labels of [['type:bug'], ['type:feature'], ['type:refactor'], ['type:docs'], ['type:chore'], [], ['type:something-new']]) {
      assert.equal(resolveStopLine(policy, labels).rung, 4, labels.join(','));
    }
    assert.equal(policy.effortStopLines.size, 0, 'no effort overrides the type table');
  });

  it('runs every stage on one option per model family', () => {
    for (const stage of ['shape', 'assess', 'sweep', 'fix', 'merge']) {
      assert.deepEqual(stageOptions(policy, stage).map((o) => o.runtime).sort(), ['claude-local', 'pi-local'], stage);
    }
  });

  it('reviews each family\'s work first with a model of the other family', () => {
    for (const author of ['claude', 'pi'] as const) {
      const first = reviewTiersFor(policy, author)[0]!;
      assert.notEqual(familyOf(first.runtime), author, `${author}-authored work is reviewed first by the other family`);
    }
  });

  it('leaves the improve stage out, so it runs nowhere here', () => {
    assert.ok('missing' in improveSettings(policy));
    assert.equal(policy.stageTiers.has('improve'), false);
  });
});

describe('a pass over agent-system with main as both the base and the release branch', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); writeFloor({ prBases: { [SLUG]: 'main' }, readOnlyProjects: [] }); });
  afterEach(() => box.cleanup());

  const config = (stopLine = 4): string => STORE_CONFIG.replace(/\| (`type:\w+`|default — [^|]*) \| 4 \|/g, `| $1 | ${stopLine} |`);

  /** A tracking issue, a ticket granted `auto`, and its pull request with a clean independent review at its head. */
  function reviewedTicket(): FakeStore {
    const store = new FakeStore();
    store.addIssue({ number: 1, labels: ['effort', 'effort:failure-handling'] });
    store.addIssue({ number: 2, labels: ['shaped', 'auto', 'type:bug', 'effort:failure-handling'] });
    const head = SHA('head-2');
    store.addPull({ number: 3, headRefOid: head, headRefName: 'ticket/2', baseRefName: 'main' });
    store.addComment(3, `Reviewed, nothing at medium or above.\n${renderReviewMarker({
      sha: head, findings: 0, independent: true, reviewer: 'gpt-6.1-sol·max', bodyDigest: createHash('sha256').update('').digest('hex'),
    })}`);
    return store;
  }

  async function pass(store: FakeStore, storeConfig: string, commands = new FakeCommands()) {
    const report = await runPass({ store, repo: new FakeRepo(storeConfig), commands }, { dryRun: false });
    return { report, commands };
  }
  const stageOf = (report: Awaited<ReturnType<typeof pass>>['report'], name: string) => report.stages.find((s) => s.stage === name);

  it('dispatches nothing in the merge, release and verify stages and raises no fault', async () => {
    const { report } = await pass(reviewedTicket(), config());
    for (const name of ['merge', 'release', 'verify']) {
      const items = stageOf(report, name)?.items ?? [];
      assert.deepEqual(items.filter((i) => i.decision === 'dispatch'), [], `${name} dispatches nothing`);
    }
    assert.deepEqual(report.faults, []);
    assert.notEqual(report.classification, 'breach');
  });

  it('opens no release pull request even when a stop-line reaches the release rung and a ticket has merged', async () => {
    // A release pull request from main into main cannot exist. The stage says so and stays quiet.
    const store = reviewedTicket();
    store.closedPulls.push({
      number: 700, title: 'merged', headRefName: 'ticket/2', headRefOid: SHA('m700'), baseRefName: 'main', isDraft: false, body: '', author: 'p', labels: [],
      state: 'MERGED', mergedAt: '2026-11-16T10:00:00Z', mergeCommit: SHA('merge700'),
    });
    // CI is green on main, so the release rule is satisfied: the stage has nothing left to stop it but its own check.
    store.runs.push({ id: 1, status: 'completed', conclusion: 'success', headSha: SHA('origin/main'), workflow: 'CI', branch: 'main' });
    const repo = new FakeRepo(config(6));
    repo.log = () => Promise.resolve([{ sha: SHA('ok'), message: 'feat: y' }]);
    const report = await runPass({ store, repo, commands: new FakeCommands() }, { dryRun: false });
    assert.deepEqual(stageOf(report, 'release')?.items.filter((i) => i.decision === 'dispatch'), []);
    assert.deepEqual(store.writes.filter((w) => w.kind === 'pull' || w.kind === 'update-pull'), []);
    assert.deepEqual(report.faults, []);
  });

  it('verifies nothing when a deploy workflow and release checks are configured but main is also the base', async () => {
    const withChecks = config().replace('| release branch | `main` |', '| release branch | `main` |\n| deploy workflow | `Deploy` |')
      + '\n### Release checks\n\n| Check | Runs in | Command | Env files | Timeout minutes | Other exits |\n|---|---|---|---|---|---|\n| smoke | base | `node smoke.mjs` | - | 5 | blocked |\n';
    const { report } = await pass(reviewedTicket(), withChecks);
    assert.deepEqual(stageOf(report, 'verify')?.items.filter((i) => i.decision === 'dispatch'), []);
    assert.deepEqual(report.faults, []);
  });

  // Holds the decision in docs/adr/20261115-agent-system-runs-its-own-ticket-flow.md.
  it('merges nothing into main even with every stop-line raised to 5 and a merge grant in place', async () => {
    const store = reviewedTicket();
    const commands = new FakeCommands(); // its authorize() allows every action, merge-dev included
    assert.equal(commands.authorize({ repo: SLUG, workClass: 'loop-merge', runtime: 'claude-local', profile: 'default', actions: ['review', 'merge-dev'], triggerSource: `agentsys-loop:${SLUG}`, taskId: 't' }).allowed, true);
    const { report } = await pass(store, config(5), commands);
    assert.deepEqual(store.writes.filter((w) => w.kind === 'merge'), [], 'no pull request was merged');
    assert.equal(commands.dispatched.filter((d) => d.workClass === 'loop-merge').length, 0, 'no merge check was even started');
    assert.deepEqual(stageOf(report, 'merge')?.items.filter((i) => i.decision === 'dispatch'), []);
    assert.deepEqual(report.faults, []);
  });

  it('control: the same ticket on a repository whose base is dev does reach the merge stage', async () => {
    // This shows the test above holds because main is the release branch, not because the fixture could
    // never merge.
    writeFloor({ prBases: { [SLUG]: 'dev' }, readOnlyProjects: [] });
    const store = new FakeStore();
    store.addIssue({ number: 1, labels: ['effort', 'effort:failure-handling'] });
    store.addIssue({ number: 2, labels: ['shaped', 'auto', 'type:bug', 'effort:failure-handling'] });
    const head = SHA('head-2');
    store.addPull({ number: 3, headRefOid: head, headRefName: 'ticket/2', baseRefName: 'dev' });
    store.addComment(3, renderReviewMarker({ sha: head, findings: 0, independent: true, reviewer: 'x', bodyDigest: createHash('sha256').update('').digest('hex') }));
    const { report } = await pass(store, config(5));
    assert.equal(stageOf(report, 'merge')?.items.some((i) => i.decision === 'dispatch'), true, 'with a dev base the loop does reach the merge');
  });
});
