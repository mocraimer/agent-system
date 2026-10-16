import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writeFloor } from '../core/floor.js';
import { sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import { FIXTURE_QUEUE_MODULES } from '../console/testkit.js';
import { renderReviewMarker } from './markers.js';
import { runPass } from './pass.js';
import { loadQueueRules } from './queues.js';
import { completed, FakeCommands, FakeRepo, FakeStore, outputFileIn, SHA } from './testkit.js';

/**
 * `examples/ticket-loop` is the setup the README walks a new user through. These
 * tests run the loop against its store configuration as shipped, in a repository
 * that carries no queue modules of its own, so the built-in rules decide.
 */
const EXAMPLE_STORE_CONFIG = readFileSync(fileURLToPath(new URL('../../examples/ticket-loop/target-repo/tickets/store-config.md', import.meta.url)), 'utf8');
const SLUG = 'example-org/larkspur';

let box: Sandbox;
beforeEach(() => { box = sandbox(); writeFloor({ prBases: { [SLUG]: 'dev' }, readOnlyProjects: [] }); });
afterEach(() => box.cleanup());

/** A store with one ticket or pull request in each state a stage acts on. */
function exampleStore(): { store: FakeStore; repo: FakeRepo } {
  const store = new FakeStore();
  store.addIssue({ number: 1, labels: ['effort', 'effort:launch'] });
  store.addIssue({ number: 2, body: 'Readers lose their place when the list reloads.', labels: ['effort:launch'] });
  store.addIssue({ number: 3, labels: ['shaped', 'type:bug', 'effort:launch'] });
  store.addIssue({ number: 4, labels: ['shaped', 'auto', 'type:feature', 'effort:launch'] });
  store.addIssue({ number: 20, labels: ['shaped', 'auto', 'type:bug', 'effort:launch'] });
  store.addPull({ number: 20, headRefOid: SHA('head-20') });
  store.addIssue({ number: 30, labels: ['shaped', 'auto', 'type:bug', 'effort:launch'] });
  const fixHead = SHA('head-30');
  const pr = store.addPull({ number: 30, headRefOid: fixHead });
  store.addComment(30, `1. [high] the list loses its scroll position\n${renderReviewMarker({
    sha: fixHead, findings: 1, independent: true, reviewer: 'x', bodyDigest: createHash('sha256').update(pr.body).digest('hex'),
  })}`);
  store.addIssue({ number: 70, labels: ['shaped', 'auto', 'type:docs', 'effort:launch'] });
  store.closedPulls.push({
    number: 700, title: 'docs: the reading list', headRefName: 'ticket/70', headRefOid: SHA('m700'), baseRefName: 'dev', isDraft: false,
    body: '', author: 'p', labels: [], state: 'MERGED', mergedAt: '2026-09-18T10:00:00Z', mergeCommit: SHA('merge700'),
  });
  return { store, repo: new FakeRepo(EXAMPLE_STORE_CONFIG, { 'origin/ticket/30': fixHead }) };
}

describe('the example ticket loop', () => {
  it('decides every stage from the shipped store configuration with the built-in queue rules', async () => {
    const { store, repo } = exampleStore();
    const report = await runPass({ store, repo, commands: new FakeCommands() }, { dryRun: true });
    const decided = (stage: string, ref: string): string | undefined =>
      report.stages.find((s) => s.stage === stage)?.items.find((i) => i.ref === ref)?.decision;

    assert.equal(decided('shape', '#2'), 'dispatch', 'an unshaped ticket gets a proposal');
    assert.equal(decided('assess', '#1 (effort:launch)'), 'dispatch', 'the effort with an ungranted ticket gets an assessment');
    assert.equal(decided('sweep', '#4'), 'dispatch', 'the oldest granted ticket with no pull request is started');
    assert.equal(decided('review', 'PR #20'), 'dispatch', 'an unreviewed pull request is reviewed');
    assert.equal(decided('fix', 'PR #30'), 'dispatch', 'a pull request with findings at its head is fixed');
    assert.equal(decided('close', '#70'), 'dispatch', 'a merged ticket carrying auto is closed');
    assert.deepEqual(store.writes, [], 'a dry run writes nothing');
  });

  it('marks everything it writes with the prefix the store configuration names', async () => {
    const { store, repo } = exampleStore();
    // A shape run's proposal is the file its prompt names.
    const commands = new FakeCommands((input) => {
      const path = outputFileIn(input.prompt);
      if (path) writeFileSync(path, '## Definition of done\n- the list keeps its place', 'utf8');
      return completed(input);
    });
    await runPass({ store, repo, commands }, { dryRun: false, stages: ['shape', 'sweep', 'close'] });
    const written = [...store.commentsBy.values()].flat().map((c) => c.body);
    const all = store.writes.filter((w) => w.body !== undefined).map((w) => w.body!);

    assert.ok(written.some((b) => b.includes('<!-- larkspur-shape-proposal -->')), 'the shape proposal');
    assert.ok(written.some((b) => b.includes('<!-- larkspur-ticket-claim -->') && b.includes('Claimed by: larkspur-loop')), 'the sweep claim');
    assert.ok(written.some((b) => b.includes('<!-- larkspur-loop-done -->')), 'the close comment');
    for (const body of all) {
      for (const [, prefix] of body.matchAll(/<!--\s*([a-z0-9-]+?)-(?:loop|ticket|shape-proposal|auto-assessment|release)\b/g)) {
        assert.equal(prefix, 'larkspur', `a marker in "${body.slice(0, 60)}" uses the configured prefix`);
      }
    }
  });
});

// Holds the decision in docs/adr/20261014-default-queue-rules-built-in.md.
describe('queue rules', () => {
  const ref = 'origin/dev';

  it('are the built-in ones, under the configured prefix, when the target ships no modules', async () => {
    const rules = await loadQueueRules(new FakeRepo(), ref, 'larkspur');
    assert.equal(rules.SHAPE_MARKER, '<!-- larkspur-shape-proposal -->');
    assert.equal(rules.LOOP_CLAIM_LINE, 'Claimed by: larkspur-loop');
  });

  it('are the target repository\'s own when it ships both modules', async () => {
    const repo = new FakeRepo();
    for (const [name, text] of Object.entries(FIXTURE_QUEUE_MODULES)) repo.files.set(`scripts/agent-system/${name}`, text);
    const rules = await loadQueueRules(repo, ref, 'larkspur');
    assert.equal(rules.SHAPE_MARKER, '<!-- fixture-shape -->');
    assert.equal(rules.CLAIM_MARKER, '<!-- fixture-claim -->');
  });

  it('refuse a target that ships one module without the other', async () => {
    const repo = new FakeRepo();
    repo.files.set('scripts/agent-system/shape-candidates.mjs', FIXTURE_QUEUE_MODULES['shape-candidates.mjs']!);
    await assert.rejects(loadQueueRules(repo, ref, 'larkspur'), /not auto-candidates\.mjs; ship both modules or neither/);
  });

  it('name the export a target module is missing', async () => {
    const repo = new FakeRepo();
    for (const [name, text] of Object.entries(FIXTURE_QUEUE_MODULES)) {
      repo.files.set(`scripts/agent-system/${name}`, name === 'auto-candidates.mjs' ? text.replace('export const dependsOn', 'const dependsOn') : text);
    }
    await assert.rejects(loadQueueRules(repo, ref, 'larkspur'), /does not export dependsOn/);
  });
});
