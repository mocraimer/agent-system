import { test, expect, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consoleFixture, lastPass, populatedStore, startConsole, comment } from './console-fixture.js';
import { renderAcceptedMarker } from '../dist/loop/markers.js';
import { issue, proposal } from '../dist/console/testkit.js';

const shots = join(process.cwd(), 'test-results', 'decision-workspace');
mkdirSync(shots, { recursive: true });

async function stopConsole(child: ChildProcess, root: string): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// Hold a real server response, then let a later request complete first.
async function deferResponse(page: Page, pattern: string) {
  let arrived!: () => void;
  let release!: () => void;
  const requested = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const handler = async (route: import('@playwright/test').Route) => {
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response });
  };
  await page.route(pattern, handler, { times: 1 });
  return { requested, release: async () => {
    const received = page.waitForResponse((response) => response.url().includes(pattern.replaceAll('*', '')));
    release();
    await received;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  } };
}

// A long shaping proposal, so the evidence panel is exercised at a realistic length.
const CAPTURED_PROPOSAL = `## Why

A reader who edits the same collection on two devices while one is offline loses the offline
device's changes. Checked in this checkout against the current dev head.

**What happens now.** The web app and the extension both send a full copy of a collection when they
reconnect (sync/push.ts:42). The API stores whichever copy arrives last
(api/collections/save.ts:88) and answers 200 to both. Nothing compares the two copies, so an
article added on the laptop at 09:00 disappears when the phone, offline since 08:30, reconnects at
09:15 with its older list.

**Why it matters.** Collections are the feature readers use to plan what to read, and the support
inbox has three reports of "my saved articles vanished" in the last month, each from a reader who
uses the app on two devices. None of them was reproducible on one device.

**What the fix touches.** sync/push.ts sends the changes since the last acknowledged version
instead of the whole list; api/collections/save.ts applies them to the stored list, keeps both
sides' additions, and treats a removal on one side and an edit on the other as an edit. The
conflict rule lives in one function with its own tests.

Out of scope: tags and highlights sync through a different path and keep their current behaviour;
a later ticket can move them onto the same rule.`;

for (const width of [1440, 768, 390, 320]) {
  test(`decision queue and selected evidence at ${width}px`, async ({ page }) => {
    test.setTimeout(90_000);
    const root = mkdtempSync(join(tmpdir(), 'decision-layout-'));
    const fixture = consoleFixture(root, populatedStore(), lastPass('idle-empty', 'no runnable work in the last pass'));
    const { url, child } = await startConsole(fixture);
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url);
      await expect(page.locator('.decision-row').first()).toBeVisible();
      await expect(page.locator('.workspace-summary strong')).toHaveText(await page.locator('#inbox-count').innerText());
      await expect(page.locator('.workspace-summary')).toContainText('ready for the merge stage');
      await expect(page.locator('.decision-detail h2')).toBeVisible();
      await expect(page.locator('.decision-action')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: join(shots, `${width}-populated.png`), fullPage: true });
      await page.getByRole('searchbox', { name: 'Find a decision' }).fill('300');
      await page.locator('.decision-row[data-ref="#300"]').click();
      await expect(page.locator('.decision-detail h2')).toContainText('Sync: when two devices');
      await expect(page.getByRole('region', { name: 'Current decision evidence' })).toBeVisible();
      await page.screenshot({ path: join(shots, `${width}-proposal.png`), fullPage: true });
      await page.getByRole('button', { name: 'Next decision' }).click();
      await expect(page.locator('.decision-detail h2')).not.toContainText('Sync: when two devices');
      await page.getByRole('button', { name: 'Back to queue' }).click();
      await expect(page.locator('.decision-row[aria-current="true"]')).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    } finally { child.kill('SIGTERM'); rmSync(root, { recursive: true, force: true }); }
  });
}

test('older board responses cannot replace a newer selection or Activity', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'decision-race-'));
  const fixture = consoleFixture(root, populatedStore(), lastPass('idle-empty', 'no runnable work'));
  const { url, child } = await startConsole(fixture);
  try {
    await page.goto(url);
    await expect(page.locator('.decision-detail h2')).toBeVisible();
    const oldSelection = await deferResponse(page, '**/api/console/view');
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await oldSelection.requested;
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await page.locator('.decision-row[data-ref="#301"]').click();
    await expect(page.locator('.decision-detail h2')).toContainText('Importer:');
    await oldSelection.release();
    await expect(page.locator('.decision-row[data-ref="#301"]')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.decision-detail h2')).toContainText('Importer:');
    await expect(page.locator('.decision-detail h2')).toBeFocused();

    const oldBoard = await deferResponse(page, '**/api/console/view');
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await oldBoard.requested;
    await page.getByRole('button', { name: /^Activity/ }).click();
    await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
    await oldBoard.release();
    await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
    await expect(page.locator('.decision-layout')).toHaveCount(0);
  } finally { await stopConsole(child, root); }
});

test('out-of-order Inspect results cannot replace a later decision or Steer', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'inspect-race-'));
  const fixture = consoleFixture(root, populatedStore(), lastPass('idle-empty', 'no runnable work'));
  const { url, child } = await startConsole(fixture);
  try {
    await page.goto(url);
    await expect(page.locator('.decision-detail h2')).toBeVisible();
    const oldDetail = await deferResponse(page, '**/api/console/inspect?ref=%23300');
    await page.locator('.decision-row[data-ref="#300"]').click();
    await oldDetail.requested;
    // The pending detail leaves the queue accessible on the newly rendered board.
    await page.locator('.decision-row[data-ref="#301"]').click();
    await expect(page.locator('.decision-detail h2')).toContainText('Importer:');
    await oldDetail.release();
    await expect(page.locator('.decision-detail h2')).toContainText('Importer:');
    await expect(page.locator('.decision-detail h2')).toBeFocused();

    await page.getByRole('button', { name: /^Activity/ }).click();
    await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
    const oldInspect = await deferResponse(page, '**/api/console/inspect?ref=*');
    await page.locator('.activity-list .panel li button.link').first().click();
    await oldInspect.requested;
    await page.getByRole('button', { name: /^Steer/ }).click();
    await expect(page.getByRole('heading', { name: 'Stop-lines' })).toBeVisible();
    await oldInspect.release();
    await expect(page.getByRole('heading', { name: 'Stop-lines' })).toBeVisible();
    await expect(page.locator('.section-head h2')).toHaveCount(0);
  } finally { await stopConsole(child, root); }
});

test('Inspect shows a recorded attempt digest and labels a legacy attempt unknown', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'inspect-build-'));
  const fixture = consoleFixture(root, populatedStore(), lastPass('idle-empty', 'no runnable work'));
  const base = { taskId: 'loop-shape-300', attempt: 1, authority: { type: 'grant', id: 'grant_fixture', version: 1 },
    limits: { maxAttempts: 3, maxConcurrentRuns: 1, maxPaidCallUsd: 1 }, runtime: 'claude-local', profile: 'default', actions: ['review'],
    settings: { requested: { model: 'm', effort: 'high' }, resolved: { model: 'm', effort: 'high' }, observed: { model: 'unknown', effort: 'unknown' } },
    repo: 'example-org/larkspur', workClass: 'loop-shape', status: 'completed', loop: { stage: 'shape', item: '#300', workType: 'bug' } };
  mkdirSync(join(fixture.state, 'runs'), { recursive: true });
  writeFileSync(join(fixture.state, 'runs', 'run_known.json'), JSON.stringify({ ...base, id: 'run_known', startedAt: '2026-09-17T10:00:00Z',
    build: { digest: 'a'.repeat(64), revision: null, dirty: true, builtAt: '2026-09-17T00:00:00Z' } }));
  writeFileSync(join(fixture.state, 'runs', 'run_legacy.json'), JSON.stringify({ ...base, id: 'run_legacy', startedAt: '2026-09-16T10:00:00Z' }));
  writeFileSync(join(fixture.state, 'runs', 'run_attested.json'), JSON.stringify({ ...base, id: 'run_attested', taskId: 'loop-sweep-300',
    loop: { stage: 'sweep', item: '#300', workType: 'bug' }, startedAt: '2026-09-17T11:00:00Z',
    delivery: { status: 'delivered', source: 'operator-attested', by: 'fixture-operator',
      reason: 'I checked this run and its PR.', evidence: ['PR #400'], verifiedAt: '2026-09-17T12:00:00Z' } }));
  const { url, child } = await startConsole(fixture);
  try {
    await page.goto(url);
    await expect(page.locator('.decision-detail h2')).toBeVisible();
    await page.getByRole('button', { name: /^Inspect/ }).click();
    await page.getByRole('textbox', { name: 'Item to inspect' }).fill('#300');
    await page.getByRole('button', { name: 'Inspect', exact: true }).last().click();
    const attempts = page.getByRole('heading', { name: 'Recorded attempts and build' }).locator('..');
    await expect(attempts.locator('li').filter({ hasText: 'run_known' })).toContainText(`Build: ${'a'.repeat(64)}`);
    await expect(attempts.locator('li').filter({ hasText: 'run_legacy' })).toContainText('Build: unknown');
    const attested = attempts.locator('li').filter({ hasText: 'run_attested' });
    await expect(attested).toContainText('operator-attested (not automatic proof)');
    await expect(attested).toContainText('Attested by fixture-operator.');
  } finally { child.kill('SIGTERM'); rmSync(root, { recursive: true, force: true }); }
});

test('a captured full-length proposal keeps its evidence and action together without page overflow', async ({ page }) => {
  test.setTimeout(90_000);
  const root = mkdtempSync(join(tmpdir(), 'decision-long-evidence-'));
  const store = populatedStore();
  const body = 'Sync: offline edits to a collection are lost when another device saved first.';
  const shaped = proposal(body);
  shaped.body += `\n\n${CAPTURED_PROPOSAL}`;
  store.issues.push(issue(700, { title: body, body, comments: [shaped] }));
  const fixture = consoleFixture(root, store, lastPass('idle-empty', 'no runnable work'));
  const { url, child } = await startConsole(fixture);
  try {
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(width === 1440 ? url : url.slice(0, url.indexOf('#')));
      await page.getByRole('searchbox', { name: 'Find a decision' }).fill('700');
      await page.locator('.decision-row[data-ref="#700"]').click();
      await expect(page.getByRole('region', { name: 'Current decision evidence' })).toContainText('Out of scope');
      await expect(page.locator('.decision-action')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: join(shots, `${width}-long-evidence.png`), fullPage: true });
    }
  } finally { child.kill('SIGTERM'); rmSync(root, { recursive: true, force: true }); }
});

test('the selected proposal acts through the command layer, then advances to another decision', async ({ page }) => {
  test.setTimeout(90_000);
  const root = mkdtempSync(join(tmpdir(), 'decision-action-'));
  const fixture = consoleFixture(root, populatedStore(), lastPass('idle-empty', 'no runnable work'));
  const { url, child } = await startConsole(fixture);
  try {
    await page.goto(url);
    await page.locator('.decision-row[data-ref="#300"]').click();
    await expect(page.getByRole('region', { name: 'Current decision evidence' })).toContainText('the draft');
    const before = readFileSync(fixture.storeFile, 'utf8');
    const changed = JSON.parse(before);
    const target = changed.issues.find((issue: { number: number }) => issue.number === 300);
    target.body += '\nChanged since inspection.';
    writeFileSync(fixture.storeFile, JSON.stringify(changed));
    await page.locator('.decision-action button[data-action="apply-shaped"]').click();
    await expect(page.locator('.decision-action .refusal[role="alert"]')).toContainText('Action refused');
    await expect(page.locator('.decision-row[data-ref="#300"]')).toHaveCount(1);
    await page.screenshot({ path: join(shots, 'changed-fingerprint-refusal.png'), fullPage: true });
    writeFileSync(fixture.storeFile, before);
    await page.getByRole('button', { name: 'Refresh evidence' }).click();
    await expect(page.locator('.decision-detail h2')).toContainText('Sync: when two devices');
    await page.locator('.decision-action button[data-action="apply-shaped"]').click();
    await expect(page.locator('#toast')).toContainText('#300:');
    await expect(page.locator('.decision-row[data-ref="#300"]')).toHaveCount(0);
    await page.locator('.decision-row[data-ref="#301"]').click();
    await expect(page.locator('.decision-detail h2')).toContainText('Importer:');
    await page.screenshot({ path: join(shots, 'action-next.png'), fullPage: true });
  } finally { child.kill('SIGTERM'); rmSync(root, { recursive: true, force: true }); }
});

test('an unconfirmed assessment cannot grant auto even when its text is readable', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'decision-unconfirmed-assessment-'));
  const fixture = consoleFixture(root, populatedStore(), lastPass('idle-empty', 'no runnable work'));
  const { url, child } = await startConsole(fixture);
  await page.route('**/api/console/inspect?*', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    if (new URL(route.request().url()).searchParams.get('ref') === '#623') {
      data.evidence = [...(data.evidence ?? []), { kind: 'assessment', text: 'Readable but its currentness could not be checked.', current: null }];
    }
    await route.fulfill({ response, json: data });
  });
  try {
    await page.goto(url);
    await page.locator('.decision-row[data-ref="#623"]').click();
    await expect(page.locator('.decision-action button[data-action="apply-auto"]')).toBeDisabled();
    await expect(page.locator('.decision-action button[data-action="close-not-planned"]')).toBeEnabled();
    await page.getByRole('button', { name: /^Inbox/ }).click();
    const row = page.locator('.inbox-row[data-ref="#623"]');
    await expect(row.locator('button[data-action="apply-auto"]')).toBeDisabled();
  } finally { await stopConsole(child, root); }
});

test('an unavailable assessment cannot grant auto while the close alternative remains usable', async ({ page }) => {
  test.setTimeout(90_000);
  const root = mkdtempSync(join(tmpdir(), 'decision-assessment-'));
  const fixture = consoleFixture(root, populatedStore(), lastPass('idle-empty', 'no runnable work'));
  const { url, child } = await startConsole(fixture);
  try {
    await page.goto(url);
    await page.locator('.decision-row[data-ref="#623"]').click();
    await expect(page.locator('.decision-action')).toContainText('Assessment evidence is unavailable');
    await expect(page.locator('.decision-action button[data-action="apply-auto"]')).toBeDisabled();
    await expect(page.locator('.decision-action button[data-action="close-not-planned"]')).toBeEnabled();
    await page.getByRole('button', { name: /^Inbox/ }).click();
    const row = page.locator('.inbox-row[data-ref="#623"]');
    await expect(row.locator('button[data-action="apply-auto"]')).toBeDisabled();
    await expect(row.locator('button[data-action="close-not-planned"]')).toBeEnabled();
    await page.screenshot({ path: join(shots, 'missing-assessment.png'), fullPage: true });
  } finally { child.kill('SIGTERM'); rmSync(root, { recursive: true, force: true }); }
});

test('an escalation answer preserves typed text through inspection and action', async ({ page }) => {
  test.setTimeout(90_000);
  const root = mkdtempSync(join(tmpdir(), 'decision-answer-'));
  const fixture = consoleFixture(root, populatedStore(), lastPass('idle-empty', 'no runnable work'));
  const { url, child } = await startConsole(fixture);
  try {
    await page.goto(url);
    await page.getByRole('button', { name: /^Inbox/ }).click();
    const row = page.locator('.inbox-row[data-ref="#652"]');
    await row.locator('textarea[name="answer"]').fill('Use the emulator fixture in tests/rules, not a live project.');
    await expect(row.locator('textarea[name="answer"]')).toHaveValue('Use the emulator fixture in tests/rules, not a live project.');
    const actionRequest = page.waitForRequest((request) => request.url().endsWith('/api/console/actions'));
    await row.locator('button[data-action="answer-escalation"]').click();
    const request = await actionRequest;
    expect(JSON.parse(request.postData() || '{}')).toMatchObject({ ref: '#652', action: 'answer-escalation', text: 'Use the emulator fixture in tests/rules, not a live project.' });
    await expect(page.locator('#toast')).toContainText('#652:');
  } finally { child.kill('SIGTERM'); rmSync(root, { recursive: true, force: true }); }
});

test('accepted findings show the current review and a human handoff, never a clean merge claim', async ({ page }) => {
  test.setTimeout(90_000);
  const root = mkdtempSync(join(tmpdir(), 'decision-accepted-'));
  const store = populatedStore();
  const pr = store.pulls.find((item) => item.number === 679)!;
  pr.comments.push(comment(renderAcceptedMarker(pr.headRefOid)));
  const fixture = consoleFixture(root, store, lastPass('idle-empty', 'no runnable work'));
  const { url, child } = await startConsole(fixture);
  try {
    await page.goto(url);
    await page.locator('.decision-row[data-ref="PR #679"]').click();
    await expect(page.locator('.decision-detail')).toContainText('findings accepted');
    await expect(page.getByRole('region', { name: 'Review and findings' })).toContainText('findings=3');
    await expect(page.locator('.decision-action')).toContainText('human review on GitHub');
    await expect(page.locator('.decision-action button[data-action="merge"]')).toHaveCount(0);
    await page.screenshot({ path: join(shots, 'accepted-findings-handoff.png'), fullPage: true });
  } finally { child.kill('SIGTERM'); rmSync(root, { recursive: true, force: true }); }
});

test('a first failed read reports unknown counts and offers recovery on the Board', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'decision-first-failure-'));
  const fixture = consoleFixture(root, populatedStore(), lastPass('idle-empty', 'no runnable work'));
  const data = JSON.parse(readFileSync(fixture.storeFile, 'utf8'));
  data.failRead = 'network unavailable';
  writeFileSync(fixture.storeFile, JSON.stringify(data));
  const { url, child } = await startConsole(fixture);
  try {
    await page.goto(url);
    await expect(page.locator('.workspace-summary')).toContainText('decisions unknown');
    await expect(page.locator('.workspace-summary')).toContainText('Merge readiness unknown');
    await expect(page.locator('.workspace-summary')).not.toContainText('0 ready');
    delete data.failRead;
    writeFileSync(fixture.storeFile, JSON.stringify(data));
    await page.locator('.banner').getByRole('button', { name: 'Refresh store' }).click();
    await expect(page.locator('.decision-row').first()).toBeVisible();
    await expect(page.locator('.workspace-summary')).toContainText('ready for the merge stage');
  } finally { await stopConsole(child, root); }
});

test('loading, stale refusal, recovery, keyboard and reduced motion retain the decision context', async ({ page }) => {
  test.setTimeout(100_000);
  const root = mkdtempSync(join(tmpdir(), 'decision-states-'));
  const fixture = consoleFixture(root, populatedStore(), lastPass('progress', 'review produced output'));
  const { url, child } = await startConsole(fixture);
  try {
    await page.setViewportSize({ width: 390, height: 850 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/console/view', async (route) => { await gate; await route.continue(); });
    await page.goto(url);
    await expect(page.locator('.loading')).toContainText('Loading');
    release();
    await page.unroute('**/api/console/view');
    await page.getByRole('searchbox', { name: 'Find a decision' }).fill('300');
    await page.locator('.decision-row[data-ref="#300"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.decision-detail h2')).toBeFocused();
    await page.screenshot({ path: join(shots, 'keyboard-reduced-motion.png'), fullPage: true });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: join(shots, 'text-200-percent.png'), fullPage: true });
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    const original = readFileSync(fixture.storeFile, 'utf8');
    writeFileSync(fixture.storeFile, JSON.stringify({ ...JSON.parse(original), failRead: 'HTTP 502' }));
    await page.reload();
    await expect(page.locator('.banner.warn')).toContainText('HTTP 502');
    await expect(page.locator('.decision-detail')).toContainText('Stale snapshot');
    await expect(page.locator('.decision-action button[data-action]').first()).toBeDisabled();
    await page.screenshot({ path: join(shots, 'stale.png'), fullPage: true });
    writeFileSync(fixture.storeFile, original);
    await page.reload();
    await expect(page.locator('.banner.warn')).toHaveCount(0);
    await expect(page.locator('.decision-row').first()).toBeVisible();
    await page.screenshot({ path: join(shots, 'recovered.png'), fullPage: true });
  } finally { child.kill('SIGTERM'); rmSync(root, { recursive: true, force: true }); }
});
