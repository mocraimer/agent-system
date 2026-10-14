import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoordinatorCommands, recoverUnsettled } from '../dist/commands.js';
import { createGrant } from '../dist/core/authority.js';
import { listReservations } from '../dist/core/admission.js';
import { listRuns } from '../dist/core/run.js';
import { getScorecard } from '../dist/eval/scorecard.js';
import { createConsoleCommands } from '../dist/console/commands.js';
import { FileStore } from '../dist/console/file-store.js';
import { consoleTarget } from '../dist/console/service.js';
import { card, claim, FIXTURE_SLUG, issue, pull, review } from '../dist/console/testkit.js';
import { GitRepo } from '../dist/loop/git.js';
import { actOnStageItem, coordinatorCommands, runPass } from '../dist/loop/pass.js';
import { FakeCommands, fixtureRules, SHA } from '../dist/loop/testkit.js';
import { startUiServer } from '../dist/ui/server.js';
import type { DispatchInput, DispatchResult, RuntimeAdapter, RuntimeCapabilities } from '../src/adapters/types.js';
import type { Outcome } from '../src/core/outcome.js';
import type { UsageResult } from '../src/core/usage.js';
import type { StoreFile } from '../src/console/file-store.js';
import { consoleFixture, lastPass, OPERATOR, populatedStore } from './console-fixture.js';

const ACTOR = { kind: 'operator' as const, id: OPERATOR };

/**
 * A claude-local stand-in. `check-pr` runs answer PASS, or FAIL for the heads in
 * `failing`; any other run completes at once, or — with `block` — waits until it
 * is stopped, the way a long model run would.
 */
class JourneyAdapter implements RuntimeAdapter {
  readonly capabilities: RuntimeCapabilities = {
    runtime: 'claude-local', subscriptionId: 'journey-subscription', supportsModelSelection: true, supportsEffortSelection: true,
    effortLevels: ['low', 'medium', 'high'], reportsEffectiveSettings: true, acceptsCallerSessionId: true, skillInvocationForm: '/fake <task>',
  };
  block = false;
  failing = new Set<string>();
  dispatched: DispatchInput[] = [];
  private waiting = new Map<string, () => void>();
  private sessions = 0;

  readUsage(): Promise<UsageResult> {
    return Promise.resolve({ ok: true, reading: { subscriptionId: 'journey-subscription', observedAt: new Date().toISOString(), source: 'journey fake', windows: [
      { kind: 'five-hour', usedPercent: 1, vendorLabel: 'five-hour' }, { kind: 'weekly', usedPercent: 1, vendorLabel: 'weekly' },
    ] } });
  }
  checkReadiness(): Promise<Outcome | undefined> { return Promise.resolve(undefined); }
  newSessionId(): string { return `journey-session-${++this.sessions}`; }
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    this.dispatched.push(input);
    mkdirSync(input.evidenceDir, { recursive: true });
    const settings = { requested: { model: input.settings.model ?? 'x', effort: input.settings.effort ?? 'x' }, resolved: { model: input.settings.model ?? 'x', effort: input.settings.effort ?? 'x' }, observed: { model: input.settings.model ?? 'x', effort: input.settings.effort ?? 'x' } };
    const check = /check-pr skill for .*\/pull\/(\d+)/.exec(input.task);
    if (check) {
      const head = /The head you are checking is ([0-9a-f]+)/.exec(input.task)?.[1] ?? '';
      const verdict = this.failing.has(head) ? '## check-pr: FAIL\n- a required check is red' : '## check-pr: PASS';
      writeFileSync(join(input.evidenceDir, 'claude-local-stdout.json'), JSON.stringify({ result: verdict }));
      return { outcome: { kind: 'completed', taskId: input.taskId, runId: input.runId, summary: 'checked', nextAction: 'none' }, settings };
    }
    if (this.block) {
      await new Promise<void>((resolve) => this.waiting.set(input.sessionId ?? input.runId, resolve));
      return { outcome: { kind: 'checks-failed', taskId: input.taskId, runId: input.runId, summary: 'stopped before it finished', nextAction: 'redispatch it' }, settings };
    }
    return { outcome: { kind: 'completed', taskId: input.taskId, runId: input.runId, summary: 'done', nextAction: 'none' }, settings };
  }
  reconcile(): Promise<Outcome> { return Promise.resolve({ kind: 'checks-failed', summary: 'not running', nextAction: 'none' }); }
  stop(sessionId: string): Promise<boolean> {
    const done = this.waiting.get(sessionId);
    if (!done) return Promise.resolve(false);
    this.waiting.delete(sessionId);
    done();
    return Promise.resolve(true);
  }
}

function journeyStore() {
  const store = populatedStore();
  const failingHead = SHA('head-704');
  store.issues.push(issue(404, { title: 'Clean ticket whose check-pr fails', labels: ['type:chore'] }));
  store.issues.push(issue(637, { title: 'Web: upgrade the date library to the current minor release', labels: ['auto', 'shaped', 'effort:backlog'], comments: [claim()] }));
  store.referencedPulls.push(pull(661, { headRefName: 'ticket/637', state: 'MERGED', mergedAt: '2026-09-13T19:59:00Z', mergedBy: OPERATOR }));
  store.pulls.push(pull(704, { title: 'chore: a clean PR whose check-pr fails', headRefName: 'ticket/404', headRefOid: failingHead, comments: [review(failingHead, 0)] }));
  return { store, failingHead };
}

const storeFile = (path: string): StoreFile => JSON.parse(readFileSync(path, 'utf8')) as StoreFile;

async function inboxAction(page: Page, ref: string, action: string, before?: (row: ReturnType<Page['locator']>) => Promise<void>): Promise<void> {
  await page.getByRole('button', { name: /^Inbox/ }).click();
  const row = page.locator(`.inbox-row[data-ref="${ref}"]`);
  await expect(row).toBeVisible();
  if (before) await before(row);
  await row.locator(`button[data-action="${action}"]`).click();
  await expect(page.locator('#toast')).toContainText(ref);
}

test.use({ viewport: { width: 1280, height: 800 } });

test('every inbox action goes through the command layer, records what it did, and the item leaves on refresh', async ({ page }) => {
  test.setTimeout(120_000);
  const root = mkdtempSync(join(tmpdir(), 'console-journey-'));
  const { store: snapshot, failingHead } = journeyStore();
  const cards = [card('card_loop-shape-318-aa', { stage: 'shape', item: '#318', workType: 'chore', wrote: 'comment 1' })];
  const f = consoleFixture(root, snapshot, lastPass('progress', 'shape 2/2 produced'), cards);
  process.env.AGENTSYS_STATE = f.state;
  const fake = new JourneyAdapter();
  fake.failing.add(failingHead);
  const commands = createCoordinatorCommands(() => fake);
  createGrant(ACTOR, {
    repos: [FIXTURE_SLUG], workClasses: ['loop-merge'], triggerSources: [`agentsys-loop:${FIXTURE_SLUG}`], actions: ['merge-dev', 'review'],
    runtimes: ['claude-local'], profiles: ['default'], perTask: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
    aggregate: { maxDispatchesPerWindow: 20, windowHours: 24, maxConcurrentRuns: 1 }, reason: 'journey fixture',
  });
  const repo = new GitRepo(f.repo);
  const store = new FileStore(f.storeFile);
  let stageCalls = 0;
  const consoleCommands = createConsoleCommands({
    target: await consoleTarget(repo, store), store, git: repo, coordinator: commands,
    mergeStage: (ref) => { stageCalls++; return actOnStageItem({ repo, store, commands: coordinatorCommands(() => fake) }, 'merge', ref); },
  });
  const server = await startUiServer({ repoRoots: [root], commands, console: consoleCommands });
  try {
    await page.goto(server.url);
    await expect(page.locator('.state-pill')).toHaveText('Needs you');

    // apply shaped, with an explicit verdict on the proposal's scorecard
    await inboxAction(page, '#318', 'apply-shaped', async (row) => {
      await row.locator('summary').click();
      await row.locator('select[name="verdict"]').selectOption('accepted');
      await row.locator('input[name="reason"]').fill('a clean proposal');
    });
    await expect(page.locator('.inbox-row[data-ref="#318"]')).toHaveCount(0);
    expect(storeFile(f.storeFile).writes.at(-1)).toMatchObject({ kind: 'add-labels', target: 318, detail: 'shaped' });
    expect(getScorecard('card_loop-shape-318-aa')?.feedback).toMatchObject({ verdict: 'accepted', by: OPERATOR, reason: 'a clean proposal' });

    await inboxAction(page, '#301', 'close-not-planned');
    await expect(page.locator('.inbox-row[data-ref="#301"]')).toHaveCount(0);
    expect(storeFile(f.storeFile).writes.at(-1)).toMatchObject({ kind: 'close', target: 301, detail: 'not planned' });

    // An auto grant requires the live queue fingerprint, not merely a marked
    // tracking comment. Post this after the earlier actions changed the queue.
    const rules = fixtureRules();
    const issues = await store.listOpenIssues();
    const devHead = await repo.revParse('origin/dev');
    const assessment = rules.decide({ issues, effortLabel: 'effort:backlog', dependencyStates: {}, devHead, priorComment: null });
    await store.createComment(640, `${rules.MARKER}\n${rules.renderFingerprint(assessment.fingerprint)}\n\n#623 is ready to grant; shaped and awaiting a separate operator decision.`);
    await inboxAction(page, '#623', 'apply-auto');
    await expect(page.locator('.inbox-row[data-ref="#623"]')).toHaveCount(0);
    expect(storeFile(f.storeFile).writes.at(-1)).toMatchObject({ kind: 'add-labels', target: 623, detail: 'auto' });

    await inboxAction(page, '#660', 'release-claim');
    await expect(page.locator('.inbox-row[data-ref="#660"]')).toHaveCount(0);
    expect(storeFile(f.storeFile).writes.at(-1)).toMatchObject({ kind: 'unassign', target: 660, detail: 'someone-else' });

    await inboxAction(page, '#690', 'dismiss-fault');
    await expect(page.locator('.inbox-row[data-ref="#690"]')).toHaveCount(0);
    expect(storeFile(f.storeFile).writes.slice(-2).map((w) => w.kind)).toEqual(['comment', 'close']);

    await inboxAction(page, '#652', 'answer-escalation', async (row) => {
      await row.locator('textarea[name="answer"]').fill('Use the emulator fixture in tests/rules, not a live project.');
    });
    await expect(page.locator('.inbox-row[data-ref="#652"]')).toHaveCount(0);
    const answered = storeFile(f.storeFile).writes.slice(-2);
    expect(answered.map((w) => w.kind)).toEqual(['comment', 'remove-label']);
    expect(answered[0]!.detail).toContain('Use the emulator fixture');

    await inboxAction(page, '#637', 'close-completed');
    await expect(page.locator('.inbox-row[data-ref="#637"]')).toHaveCount(0);
    expect(storeFile(f.storeFile).writes.at(-1)).toMatchObject({ kind: 'close', target: 637, detail: 'completed' });

    // merge: through the merge stage, which runs check-pr and merges with a merge commit
    const before = fake.dispatched.length;
    await inboxAction(page, 'PR #702', 'merge');
    await expect(page.locator('#toast')).toContainText('merged PR #702');
    expect(stageCalls).toBe(1);
    expect(fake.dispatched.slice(before).some((d) => d.task.includes('check-pr skill for https://github.com/example-org/larkspur/pull/702'))).toBe(true);
    expect(storeFile(f.storeFile).writes.at(-1)).toMatchObject({ kind: 'merge', target: 702 });
    await expect(page.locator('.inbox-row[data-ref="PR #702"]')).toHaveCount(0);

    // A refusal is shown as the coordinator worded it.
    await page.getByRole('button', { name: /^Inbox/ }).click();
    const row = page.locator('.inbox-row[data-ref="PR #704"]');
    await row.locator('button[data-action="merge"]').click();
    await expect(row.locator('.refusal')).toBeVisible();
    await expect(row.locator('.refusal')).toHaveText(/^The merge stage acted on PR #704 and produced nothing: check-pr did not pass: ## check-pr: FAIL - a required check is red$/);
    // Nothing was merged: the last write is still #702's merge.
    expect(storeFile(f.storeFile).writes.at(-1)).toMatchObject({ kind: 'merge', target: 702 });
    await page.screenshot({ path: join(process.cwd(), 'test-results', 'console-screens', 'inbox-refusal.png') });
  } finally {
    await server.close();
    delete process.env.AGENTSYS_STATE;
    rmSync(root, { recursive: true, force: true });
  }
});

test('pause and resume a stage, stop a run in flight, and redispatch it', async ({ page }) => {
  test.setTimeout(120_000);
  const root = mkdtempSync(join(tmpdir(), 'console-steer-journey-'));
  const f = consoleFixture(root, populatedStore(), lastPass('progress', 'shape 1/1 produced'));
  process.env.AGENTSYS_STATE = f.state;
  const fake = new JourneyAdapter();
  const commands = createCoordinatorCommands(() => fake);
  const grant = createGrant(ACTOR, {
    repos: [FIXTURE_SLUG], workClasses: ['loop-sweep'], triggerSources: [`agentsys-loop:${FIXTURE_SLUG}`], actions: ['author-changes', 'push-branch', 'open-pr'],
    runtimes: ['claude-local'], profiles: ['default'], perTask: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
    aggregate: { maxDispatchesPerWindow: 20, windowHours: 24, maxConcurrentRuns: 1 }, reason: 'journey fixture',
  });
  const repo = new GitRepo(f.repo);
  const store = new FileStore(f.storeFile);
  const consoleCommands = createConsoleCommands({ target: await consoleTarget(repo, store), store, git: repo, coordinator: commands, mergeStage: () => Promise.reject(new Error('unused')) });
  const server = await startUiServer({ repoRoots: [root], commands, console: consoleCommands });
  try {
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Steer' }).click();

    // Pause: the next pass logs it and dispatches nothing from the stage.
    await page.locator('li[data-stage="shape"] button').click();
    await expect(page.locator('li[data-stage="shape"]')).toContainText(`paused by ${OPERATOR}`);
    const passWith = async () => {
      const loop = new FakeCommands();
      const lines: string[] = [];
      await runPass({ repo, store, commands: loop, log: (l: string) => lines.push(l) }, { dryRun: false, stages: ['shape'] });
      return { lines, shapes: loop.dispatched.filter((d) => d.workClass === 'loop-shape').length };
    };
    const paused = await passWith();
    expect(paused.lines.some((l) => l.includes(`shape stage paused by operator ${OPERATOR}`))).toBe(true);
    expect(paused.shapes).toBe(0);
    await page.locator('li[data-stage="shape"] button').click();
    await expect(page.locator('li[data-stage="shape"]')).toContainText('running');
    const resumed = await passWith();
    expect(resumed.lines.some((l) => l.includes('paused by operator'))).toBe(false);
    expect(resumed.shapes).toBeGreaterThan(0);

    // Stop: a run that would otherwise wait for ever.
    fake.block = true;
    const request = {
      taskId: 'loop-sweep-900', repo: FIXTURE_SLUG, workClass: 'loop-sweep', runtime: 'claude-local' as const, profile: 'default',
      actions: ['author-changes' as const, 'push-branch' as const, 'open-pr' as const], prBase: 'dev', triggerSource: `agentsys-loop:${FIXTURE_SLUG}`,
      prompt: 'Invoke run-ticket for ticket 900.', repoPath: f.repo, settings: { model: 'model-sweep', effort: 'low' },
      estimate: { fiveHourPercent: 1, weeklyPercent: 1, basis: 'operator-bound' as const, uncertaintyPercent: 1, detail: 'journey bound' }, entry: 'prompt' as const,
    };
    const inFlight = commands.dispatch(request);
    await expect.poll(() => listRuns().find((r) => r.taskId === 'loop-sweep-900')?.status).toBe('running');
    const first = listRuns().find((r) => r.taskId === 'loop-sweep-900')!;
    await page.getByRole('button', { name: 'Board' }).click();
    await page.getByRole('button', { name: 'Steer' }).click();
    await page.locator(`tr[data-run="${first.id}"] button`).click();
    await expect(page.locator('#toast')).toContainText(`Stopped ${first.id}`);
    const ended = await inFlight;
    expect(ended.outcome.kind).toBe('checks-failed');
    expect(listRuns().find((r) => r.id === first.id)?.status).toBe('checks-failed');
    expect(getScorecard('card_loop-sweep-900')?.stops).toEqual([expect.objectContaining({ runId: first.id, by: OPERATOR })]);
    expect(getScorecard('card_loop-sweep-900')?.finalStatus).toBe('checks-failed');
    await recoverUnsettled(undefined, () => fake);
    expect(listReservations().filter((r) => r.runId === first.id && r.state !== 'released')).toEqual([]);

    // Redispatch: the same task text under the same grant, as a new run.
    fake.block = false;
    await page.getByRole('button', { name: 'Board' }).click();
    await page.getByRole('button', { name: 'Steer' }).click();
    await expect(page.locator(`tr[data-run="${first.id}"]`)).toContainText('No confirmed success');
    await page.locator(`tr[data-run="${first.id}"] button`).click();
    await expect(page.locator('#toast')).toContainText('Redispatch of loop-sweep-900 started');
    await expect.poll(() => listRuns().filter((r) => r.taskId === 'loop-sweep-900').length).toBe(2);
    const second = listRuns().find((r) => r.taskId === 'loop-sweep-900' && r.id !== first.id)!;
    await expect.poll(() => listRuns().find((r) => r.id === second.id)?.status).toBe('completed');
    expect(second.authority.id).toBe(grant.id);
    expect(first.authority.id).toBe(grant.id);
    expect(fake.dispatched.filter((d) => d.taskId === 'loop-sweep-900').map((d) => d.task)).toEqual([request.prompt, request.prompt]);
    expect(second.id).not.toBe(first.id);
  } finally {
    await server.close();
    delete process.env.AGENTSYS_STATE;
    rmSync(root, { recursive: true, force: true });
  }
});
