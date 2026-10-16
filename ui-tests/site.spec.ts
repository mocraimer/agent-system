import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, relative } from 'node:path';

/**
 * The explainer page in a real browser: it loads, fits a phone and a desktop, copies its
 * commands, switches tabs, works from the keyboard, still shows every command with
 * JavaScript off, and holds still when the reader asks for less motion.
 *
 * It serves `site/` from a local HTTP server. Browsers treat a loopback address as a secure
 * context, which the clipboard API needs. The two font hosts are answered locally, so the page
 * tests need no network and any other request that fails is a defect. Only the link-preview
 * test lets the typefaces load, so the image shows them; it also passes offline, in system fonts.
 *
 * The first screen is captured for the five-second glance task (T9 in docs/READER-TASKS.md): at
 * 1280 by 800 and 390 by 740, 2 seconds after load, at rest, and at rest with reduced motion. The
 * shots land in test-results/site-first-screen/ as {desktop,phone}-{2s,rest,reduced}.png.
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
    const file = join(SITE, path === '/' ? 'index.html' : path);
    if (relative(SITE, file).startsWith('..') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
});

/** Answer the font hosts with an empty stylesheet, so the page falls back to system fonts, offline. */
async function offlineFonts(context: BrowserContext): Promise<void> {
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 204, body: '' }));
}

interface Opened { page: Page; context: BrowserContext; problems: string[] }

/** An attribute that must be there: a missing one would make a `#` selector that matches every element with an id. */
async function attr(locator: Locator, name: string): Promise<string> {
  const value = await locator.getAttribute(name);
  expect(value, `${name} is missing`).toBeTruthy();
  return value!;
}

/** Open the page in a fresh context, run the test body, check that the page raised no error, and close the context even when the body throws. */
async function withPage(browser: Browser, options: Parameters<Browser['newContext']>[0], body: (opened: Opened) => Promise<void>): Promise<void> {
  const context = await browser.newContext(options);
  try {
    await offlineFonts(context);
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
    await page.goto(base);
    await body({ page, context, problems });
    expect(problems, 'console errors, page errors or failed requests').toEqual([]);
  } finally {
    await context.close();
  }
}

for (const [width, height] of [[1280, 800], [375, 812]] as const) {
  test(`at ${width} by ${height}: no errors, every image loads, no sideways scroll`, async ({ browser }) => {
    await withPage(browser, { viewport: { width, height } }, async ({ page }) => {
      // Three of the four screenshots sit in tabs that stay hidden until chosen, so open each tab.
      for (const tab of await page.locator('#consoleTabs [role=tab]').all()) {
        await tab.click();
        const img = page.locator(`#${await attr(tab, 'aria-controls')} img`);
        await img.scrollIntoViewIfNeeded();
        await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { message: 'screenshot loaded' }).toBe(true);
      }
      const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
    });
  });
}

test('each copy button puts exactly its command text on the clipboard and shows it was copied', async ({ browser }) => {
  await withPage(browser, { viewport: { width: 1280, height: 800 } }, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    expect(await page.locator('.copy').count()).toBe(2);
    for (const tab of ['#t-you', '#t-agent']) {
      await page.locator(tab).click();
      const panel = page.locator(`#${await attr(page.locator(tab), 'aria-controls')}`);
      const button = panel.locator('.copy');
      const expected = await page.locator(`#${await attr(button, 'data-copy')}`).evaluate((el) => el.textContent ?? '');
      await button.click();
      await expect(button).toHaveText('copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
      await expect(button).toHaveText('copy');
    }
  });
});

test('tabs switch the panel, mark the active tab, and move with the arrow keys', async ({ browser }) => {
  await withPage(browser, { viewport: { width: 1280, height: 800 } }, async ({ page }) => {
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
  });
});

test('the keyboard reaches every copy button and each shows a focus ring', async ({ browser }) => {
  await withPage(browser, { viewport: { width: 1280, height: 800 } }, async ({ page }) => {
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
  });
});

test('with JavaScript off, every command and every screenshot is still on the page', async ({ browser }) => {
  await withPage(browser, { viewport: { width: 1280, height: 800 }, javaScriptEnabled: false }, async ({ page }) => {
    await expect(page.locator('#cmdYou')).toBeVisible();
    await expect(page.locator('#cmdYou')).toContainText('npm install -g .');
    await expect(page.locator('#cmdYou')).toContainText('agentsys init --operator you@example.com');
    await expect(page.locator('#cmdAgent')).toBeVisible();
    await expect(page.locator('#cmdAgent')).toContainText('docs/AGENT-SETUP.md');
    for (const figure of ['#p-board', '#p-inbox', '#p-empty', '#p-stale']) await expect(page.locator(figure)).toBeVisible();
    await expect(page.locator('.copy').first()).toBeHidden();
    const lines = await page.locator('#heroTerm .ln').all();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) await expect(line).toBeVisible();
  });
});

test('with reduced motion, nothing animates and every line of the hero terminal shows at once', async ({ browser }) => {
  await withPage(browser, { viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' }, async ({ page }) => {
    for (const line of await page.locator('#heroTerm .ln').all()) await expect(line).toBeVisible();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
  });
});

const FIRST_SCREENS = [
  { name: 'desktop', width: 1280, height: 800, scale: 1 },
  { name: 'phone', width: 390, height: 740, scale: 2 },
] as const;
const FIRST_SCREEN_DIR = join(process.cwd(), 'test-results', 'site-first-screen');
/** When the page is at rest: later than any motion it plays, so the same wait suits a page that types or one that slides. */
const REST_MS = 8_000;

/** Save a screenshot of the visible first screen and check it is the size the viewer sees. */
async function captureFirstScreen(page: Page, file: string, width: number, height: number, scale: number): Promise<void> {
  mkdirSync(FIRST_SCREEN_DIR, { recursive: true });
  const shot = await page.screenshot({ path: join(FIRST_SCREEN_DIR, file) });
  expect(shot.readUInt32BE(16), `${file} width`).toBe(width * scale);
  expect(shot.readUInt32BE(20), `${file} height`).toBe(height * scale);
}

for (const { name, width, height, scale } of FIRST_SCREENS) {
  test(`the first screen at ${width} by ${height} is captured 2 seconds after load and at rest`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base);
      const loaded = Date.now();
      await page.waitForTimeout(Math.max(0, 2_000 - (Date.now() - loaded)));
      await captureFirstScreen(page, `${name}-2s.png`, width, height, scale);
      await page.waitForTimeout(Math.max(0, REST_MS - (Date.now() - loaded)));
      await captureFirstScreen(page, `${name}-rest.png`, width, height, scale);
      expect(errors, 'page errors while the first screen played').toEqual([]);
    } finally {
      await context.close();
    }
  });

  test(`the first screen at ${width} by ${height} is captured at rest with reduced motion`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(base);
      await page.waitForTimeout(500);
      await captureFirstScreen(page, `${name}-reduced.png`, width, height, scale);
    } finally {
      await context.close();
    }
  });
}

test('the first screen at 1200 by 630 is written for the link preview', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 630 } });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    // The terminal types out; wait until every line shows and the cursor is gone.
    await page.waitForFunction(() => {
      const lines = [...document.querySelectorAll<HTMLElement>('#heroTerm .ln')];
      return lines.length > 0 && lines.every((l) => l.style.display !== 'none') && !document.querySelector('#heroTerm .cursor');
    }, undefined, { timeout: 15_000 }).catch((err: unknown) => {
      throw new Error(`the hero terminal did not finish typing; page errors: ${errors.join('; ') || 'none'}`, { cause: err });
    });
    await page.waitForTimeout(400);
    expect(errors, 'page errors while the first screen loaded').toEqual([]);
    mkdirSync(join(process.cwd(), 'test-results'), { recursive: true });
    const shot = await page.screenshot({ path: join(process.cwd(), 'test-results', 'site-og.png') });
    expect(shot.readUInt32BE(16)).toBe(1200);
    expect(shot.readUInt32BE(20)).toBe(630);
  } finally {
    await context.close();
  }
});
