import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRepo } from '../dist/loop/git.js';
import { FileStore } from '../dist/console/file-store.js';
import { consoleTarget, readBoard } from '../dist/console/service.js';
import {
  consoleFixture, emptyStore, fixtureCards, lastPass, populatedStore, startConsole,
} from './console-fixture.js';
import type { ConsoleFixture } from './console-fixture.js';

const SHOTS = join(process.cwd(), 'test-results', 'console-screens');
mkdirSync(SHOTS, { recursive: true });

/** The fact model's own counts for a fixture, computed the way the server does. */
async function modelCounts(f: ConsoleFixture): Promise<Record<string, number>> {
  const previous = process.env.AGENTSYS_STATE;
  process.env.AGENTSYS_STATE = f.state;
  try {
    const { board } = await readBoard(await consoleTarget(new GitRepo(f.repo), new FileStore(f.storeFile)));
    return board.counts;
  } finally {
    if (previous === undefined) delete process.env.AGENTSYS_STATE;
    else process.env.AGENTSYS_STATE = previous;
  }
}

test.use({ viewport: { width: 1280, height: 800 } });

test('the real entry point puts the decision queue beside current evidence, while controls remain reachable', async ({ page }) => {
  test.setTimeout(90_000);
  const root = mkdtempSync(join(tmpdir(), 'console-e2e-'));
  const f = consoleFixture(root, populatedStore(), lastPass('stalled', 'sweep stage 1 item(s) waited 2 consecutive passes with nothing produced'), fixtureCards());
  const { url, child } = await startConsole(f);
  try {
    await page.goto(url);
    await expect(page.locator('.state-pill')).toHaveText('Stalled');
    await expect(page.locator('.state-detail')).toContainText('waited 2 consecutive passes');
    await expect(page.getByRole('button', { name: 'Board' })).toHaveClass(/active/);
    await expect(page.locator('.nav .nav-button')).toHaveText(['Board', /^Inbox/, 'Activity', 'Steer', 'Inspect', 'Advanced']);

    const expected = await modelCounts(f);
    const decisions = expected['Needs you']! + expected['Ready to merge']!;
    expect(expected['Needs you']).toBeGreaterThanOrEqual(20);
    await expect(page.locator('.workspace-summary strong')).toHaveText(String(expected['Needs you']));
    await expect(page.locator('.workspace-summary')).toContainText(`${expected['Ready to merge']} ready for the merge stage`);
    await expect(page.locator('.decision-row')).toHaveCount(decisions);
    await expect(page.locator('#inbox-count')).toHaveText(String(expected['Needs you']));
    await expect(page.getByRole('region', { name: 'Selected decision' })).toBeVisible();
    await expect(page.locator('.decision-action')).toBeInViewport();
    await page.screenshot({ path: join(SHOTS, 'board-populated.png') });

    await page.getByRole('button', { name: /^Inbox/ }).click();
    await expect(page.getByRole('heading', { name: `Needs you (${expected['Needs you']})` })).toBeVisible();
    await expect(page.locator('.inbox-row:not(.ready)')).toHaveCount(expected['Needs you']!);
    await expect(page.locator('.inbox-row.ready')).toHaveCount(expected['Ready to merge']!);
    await page.screenshot({ path: join(SHOTS, 'inbox.png') });

    await page.getByRole('button', { name: 'Activity' }).click();
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Loop and queued work' })).toContainText('In review');
    await page.getByRole('button', { name: 'Steer' }).click();
    await expect(page.getByRole('heading', { name: 'Stop-lines' })).toBeVisible();
    await expect(page.locator('tr[data-row="type:chore"] td.live')).toHaveText('5');
    // A stage lists one tier row per runtime; the runtime names the row and is not edited.
    await expect(page.locator('tr[data-row="shape · claude-local"] td.live')).toHaveText('claude-local · model-shape · low · 1% · 1%');
    await expect(page.locator('tr[data-row="shape · pi-local"] td.live')).toHaveText('pi-local · model-gpt · high · 0% · 1%');
    await expect(page.locator('tr[data-row="shape · pi-local"] input[aria-label="Runtime for shape · pi-local"]')).toHaveJSProperty('readOnly', true);
    await expect(page.locator('tr[data-row^="assess"]')).toHaveCount(1);
    await expect(page.locator('li[data-stage="sweep"]')).toContainText('running');
    await page.screenshot({ path: join(SHOTS, 'steer.png'), fullPage: true });

    await page.getByRole('button', { name: 'Board' }).click();
    await page.locator('.decision-row[data-ref="#300"]').click();
    await expect(page.locator('.decision-detail h2')).toContainText('Sync: when two devices');
    await expect(page.getByRole('region', { name: 'Current decision evidence' })).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'selected-decision.png') });
    await page.getByRole('button', { name: 'Inspect' }).click();
    await page.getByRole('textbox', { name: 'Item to inspect' }).fill('PR #679');
    await page.getByRole('button', { name: 'Inspect', exact: true }).last().click();
    await expect(page.getByRole('region', { name: 'Review and findings' })).toContainText('findings=3 independent=yes');
    await expect(page.getByRole('heading', { name: 'Trust: bug' })).toBeVisible();

    await page.getByRole('button', { name: 'Advanced' }).click();
    await expect(page.getByText('Approval-only operation.')).toBeVisible();
    // Safety reads live runtimes; control-ui.spec drives it with fake adapters.
    for (const [tab, heading] of [['Work', 'Work queue'], ['Authority', 'Approvals'], ['Evidence', 'Required checks']] as const) {
      await page.locator(`.subnav [data-advanced="${tab.toLowerCase()}"]`).click();
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
  } finally {
    child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty store with an idle loop renders as Nothing to do', async ({ page }) => {
  test.setTimeout(60_000);
  const root = mkdtempSync(join(tmpdir(), 'console-e2e-empty-'));
  const f = consoleFixture(root, emptyStore(), lastPass('idle-empty', "every stage's queue was empty"));
  const { url, child } = await startConsole(f);
  try {
    await page.goto(url);
    await expect(page.locator('.state-pill')).toHaveText('Nothing to do');
    await expect(page.locator('.mood')).toContainText("every stage's queue was empty");
    await expect(page.locator('.workspace-summary strong')).toHaveText('0');
    await expect(page.locator('.decision-row')).toHaveCount(0);
    await expect(page.getByText('No decisions need you right now.')).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'board-nothing-to-do.png') });
    await page.getByRole('button', { name: /^Inbox/ }).click();
    await expect(page.getByText('Inbox zero. Nothing waits on you.')).toBeVisible();
  } finally {
    child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed store read shows the last snapshot with its age, not an empty board', async ({ page }) => {
  test.setTimeout(60_000);
  const root = mkdtempSync(join(tmpdir(), 'console-e2e-stale-'));
  const f = consoleFixture(root, populatedStore(), lastPass('progress', 'review 1/1 produced'));
  const { url, child } = await startConsole(f);
  try {
    await page.goto(url);
    await expect(page.locator('.state-pill')).toHaveText('Needs you');
    const needs = await page.locator('.workspace-summary strong').textContent();
    // GitHub stops answering.
    const { readFileSync, writeFileSync } = await import('node:fs');
    const file = JSON.parse(readFileSync(f.storeFile, 'utf8')) as Record<string, unknown>;
    writeFileSync(f.storeFile, JSON.stringify({ ...file, failRead: 'gh api graphql exited 1: HTTP 502 Bad Gateway' }));
    await page.reload();
    await expect(page.locator('.banner.warn')).toContainText('the latest GitHub read failed (gh api graphql exited 1: HTTP 502 Bad Gateway)');
    await expect(page.locator('.banner.warn')).toContainText(/old\. No verdict is derived from it\./);
    await expect(page.locator('.workspace-summary strong')).toHaveText(needs!);
    await expect(page.locator('.decision-action button[data-action]').first()).toBeDisabled();
    await page.screenshot({ path: join(SHOTS, 'board-stale.png') });
  } finally {
    child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bootstrap link pasted into an open tab connects without a reload, and a used one says so', async ({ page }) => {
  test.setTimeout(60_000);
  const root = mkdtempSync(join(tmpdir(), 'console-e2e-link-'));
  const f = consoleFixture(root, emptyStore(), lastPass('idle-empty', "every stage's queue was empty"));
  const { url, child } = await startConsole(f);
  try {
    const base = url.slice(0, url.indexOf('#'));
    const hash = url.slice(url.indexOf('#'));
    await page.goto(base);
    await expect(page.getByText('The UI session expired.')).toBeVisible();
    // Only the fragment changes, which a browser does not reload for.
    await page.evaluate((h) => { window.location.hash = h; }, hash);
    await expect(page.locator('.state-pill')).toHaveText('Nothing to do');

    const second = await page.context().browser()!.newPage();
    await second.goto(url);
    await expect(second.getByText('This link was already used.')).toBeVisible();
    await second.close();
  } finally {
    child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});
