import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';

/**
 * The explainer page in a real browser: it loads, fits a phone and a desktop, copies its
 * commands, switches tabs, works from the keyboard, still shows every command with
 * JavaScript off, and holds still when the reader asks for less motion.
 *
 * It serves `site/` from a local HTTP server, which gives the page a secure context for
 * the clipboard. The two font hosts are answered locally, so the run needs no network and
 * any other request that fails is a defect.
 *
 * The first-screen shot at 1200 by 630 pixels is written to test-results/site-og.png.
 * To refresh the link preview, run `npm run test:ui`, then:
 *   cp test-results/site-og.png site/og.png
 * Run it with the network on, so the typefaces load and the shot shows them.
 */

const SITE = join(process.cwd(), 'site');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};

let server: Server;
let base = '';

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    const file = join(SITE, path === '/' || path === '\\' ? 'index.html' : path);
    if (!file.startsWith(SITE) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

/** Answer the font hosts with an empty stylesheet, so the page falls back to system fonts, offline. */
async function offlineFonts(context: BrowserContext): Promise<void> {
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 204, body: '' }));
}

async function openPage(browser: Browser, options: Parameters<Browser['newContext']>[0]): Promise<{ page: Page; context: BrowserContext; problems: string[] }> {
  const context = await browser.newContext(options);
  await offlineFonts(context);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
  await page.goto(base);
  return { page, context, problems };
}

for (const [width, height] of [[1280, 800], [375, 812]] as const) {
  test(`at ${width} by ${height}: no errors, every image loads, no sideways scroll`, async ({ browser }) => {
    const { page, context, problems } = await openPage(browser, { viewport: { width, height } });
    // Three of the four screenshots sit in tabs that stay hidden until chosen, so open each tab.
    for (const tab of await page.locator('#consoleTabs [role=tab]').all()) {
      await tab.click();
      const img = page.locator(`#${await tab.getAttribute('aria-controls')} img`);
      await img.scrollIntoViewIfNeeded();
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { message: 'screenshot loaded' }).toBe(true);
    }
    const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
    expect(problems).toEqual([]);
    await context.close();
  });
}

test('each copy button puts exactly its command text on the clipboard and shows it was copied', async ({ browser }) => {
  const { page, context, problems } = await openPage(browser, { viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const buttons = page.locator('.copy');
  expect(await buttons.count()).toBe(2);
  for (const tab of ['#t-you', '#t-agent']) {
    await page.locator(tab).click();
    const panel = page.locator(`#${await page.locator(tab).getAttribute('aria-controls')}`);
    const button = panel.locator('.copy');
    const expected = await page.locator(`#${await button.getAttribute('data-copy')}`).evaluate((el) => el.textContent ?? '');
    await button.click();
    await expect(button).toHaveText('copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
    await expect(button).toHaveText('copy');
  }
  expect(problems).toEqual([]);
  await context.close();
});

test('tabs switch the panel, mark the active tab, and move with the arrow keys', async ({ browser }) => {
  const { page, context } = await openPage(browser, { viewport: { width: 1280, height: 800 } });
  await expect(page.locator('#p-you')).toBeVisible();
  await expect(page.locator('#p-agent')).toBeHidden();
  await page.locator('#t-agent').click();
  await expect(page.locator('#t-agent')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#t-you')).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('#p-agent')).toBeVisible();
  await expect(page.locator('#p-you')).toBeHidden();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#t-you')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#p-you')).toBeVisible();

  await expect(page.locator('#p-board')).toBeVisible();
  await page.locator('#t-inbox').click();
  await expect(page.locator('#p-inbox')).toBeVisible();
  await expect(page.locator('#p-board')).toBeHidden();
  await page.locator('#t-inbox').focus();
  await page.keyboard.press('End');
  await expect(page.locator('#t-stale')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#p-stale')).toBeVisible();
  await context.close();
});

test('the keyboard reaches every copy button and each shows a focus ring', async ({ browser }) => {
  const { page, context } = await openPage(browser, { viewport: { width: 1280, height: 800 } });
  const reached = new Set<string>();
  for (let i = 0; i < 160 && reached.size < 2; i++) {
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !el.classList.contains('copy')) return null;
      const style = getComputedStyle(el);
      return { target: el.dataset['copy'] ?? '', outline: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    if (focus) {
      expect(focus.outline).not.toBe('none');
      expect(focus.width).toBeGreaterThan(0);
      reached.add(focus.target);
    }
    // The second copy button sits in a panel that is hidden until its tab is chosen.
    if (reached.size === 1 && (await page.locator('#p-agent').isHidden())) await page.locator('#t-agent').click();
  }
  expect([...reached].sort()).toEqual(['cmdAgent', 'cmdYou']);
  await context.close();
});

test('with JavaScript off, every command and every screenshot is still on the page', async ({ browser }) => {
  const { page, context } = await openPage(browser, { viewport: { width: 1280, height: 800 }, javaScriptEnabled: false });
  await expect(page.locator('#cmdYou')).toBeVisible();
  await expect(page.locator('#cmdYou')).toContainText('npm install -g .');
  await expect(page.locator('#cmdYou')).toContainText('agentsys init --operator you@example.com');
  await expect(page.locator('#cmdAgent')).toBeVisible();
  await expect(page.locator('#cmdAgent')).toContainText('docs/AGENT-SETUP.md');
  for (const figure of ['#p-board', '#p-inbox', '#p-empty', '#p-stale']) await expect(page.locator(figure)).toBeVisible();
  await expect(page.locator('.copy').first()).toBeHidden();
  await expect(page.locator('#heroTerm .ln')).toHaveCount(4);
  for (const line of await page.locator('#heroTerm .ln').all()) await expect(line).toBeVisible();
  await context.close();
});

test('with reduced motion, nothing animates and every line of the hero terminal shows at once', async ({ browser }) => {
  const { page, context } = await openPage(browser, { viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  for (const line of await page.locator('#heroTerm .ln').all()) await expect(line).toBeVisible();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
  await context.close();
});

test('the first screen at 1200 by 630 is written for the link preview', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 630 } });
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('#heroTerm .ln').length === 4
    && [...document.querySelectorAll('#heroTerm .ln')].every((l) => (l as HTMLElement).style.display !== 'none')
    && !document.querySelector('#heroTerm .cursor'), undefined, { timeout: 15_000 });
  await page.waitForTimeout(400);
  mkdirSync(join(process.cwd(), 'test-results'), { recursive: true });
  const shot = await page.screenshot({ path: join(process.cwd(), 'test-results', 'site-og.png') });
  expect(shot.readUInt32BE(16)).toBe(1200);
  expect(shot.readUInt32BE(20)).toBe(630);
  await context.close();
});
