import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, relative } from 'node:path';

/**
 * The explainer page in a real browser: it loads, fits a phone and a desktop, shows its first
 * screen whole with scripts on, with scripts off and with reduced motion, copies its commands,
 * switches tabs, and works from the keyboard.
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
 * Two pictures come from the first screen at rest: the link preview, 1200 by 630 pixels, in
 * test-results/site-og.png, and the README's picture of the strip and the meter in
 * test-results/site-loop.png. To refresh them, run `npm run test:ui`, then:
 *   cp test-results/site-og.png site/og.png
 *   cp test-results/site-loop.png site/loop.png
 * Run it with the network on, so the typefaces load and the shots show them.
 */

const SITE = join(process.cwd(), 'site');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};
const PHONE = { width: 390, height: 740 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;

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


/** Where the first screen's moving parts are and what they show: equal in every state that shows the end frame. */
async function endFrame(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      const b = el!.getBoundingClientRect();
      return [b.x, b.y, b.width, b.height].map(Math.round);
    };
    return {
      steps: [...document.querySelectorAll('#strip li')].map((li) => ({
        text: (li.textContent ?? '').replace(/\s+/g, ' ').trim(),
        opacity: getComputedStyle(li).opacity,
        box: box(li),
      })),
      own: box(document.querySelector('.fill.own')),
      agents: box(document.querySelector('.fill.agents')),
      limit: box(document.querySelector('#limitLine')),
    };
  });
}

/** The end frame as a reduced-motion visitor sees it at once; the page must not animate. */
async function reducedFrame(browser: Browser): Promise<unknown> {
  let frame: unknown;
  await withPage(browser, { viewport: DESKTOP, reducedMotion: 'reduce' }, async ({ page }) => {
    expect(await page.evaluate(() => document.getAnimations().length), 'nothing animates').toBe(0);
    expect(await page.evaluate(() => document.documentElement.classList.contains('play'))).toBe(false);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
    frame = await endFrame(page);
  });
  return frame;
}

/** When each step first showed fully, and the agents' share's width at every frame, in the page's own clock. */
interface PlayLog { arrived: number[]; widths: number[] }

/** The number of animations still running or waiting to start. */
const running = (page: Page): Promise<number> =>
  page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);

for (const [width, height] of [[DESKTOP.width, DESKTOP.height], [PHONE.width, PHONE.height], [375, 812]] as const) {
  test(`at ${width} by ${height}: no errors and no sideways scroll`, async ({ browser }) => {
    await withPage(browser, { viewport: { width, height } }, async ({ page }) => {
      const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
    });
  });
}

for (const { width, height } of [DESKTOP, PHONE]) {
  test(`at ${width} by ${height}: the headline, the sub line, five steps and the limit line are all on the first screen`, async ({ browser }) => {
    await withPage(browser, { viewport: { width, height } }, async ({ page }) => {
      await expect.poll(() => running(page), { timeout: 10_000, message: 'the hero has stopped moving' }).toBe(0);
      const steps = page.locator('#strip li');
      expect(await steps.count()).toBe(5);
      const wanted: [string, Locator][] = [['headline', page.locator('h1')], ['sub line', page.locator('h1 + .sub')], ['limit line', page.locator('#limitLine')]];
      for (const [i, step] of (await steps.all()).entries()) wanted.push([`step ${i + 1}`, step]);
      for (const [name, locator] of wanted) {
        const box = await locator.boundingBox();
        expect(box, `${name} has no box`).not.toBeNull();
        expect(box!.x, `${name} starts left of the screen`).toBeGreaterThanOrEqual(0);
        expect(box!.y, `${name} starts above the screen`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${name} ends right of the screen`).toBeLessThanOrEqual(width);
        expect(box!.y + box!.height, `${name} ends below the screen`).toBeLessThanOrEqual(height);
      }
    });
  });
}

test('the end frame is five steps with their actors, and a meter with your use, the agents and your limit', async ({ browser }) => {
  await withPage(browser, { viewport: DESKTOP, reducedMotion: 'reduce' }, async ({ page }) => {
    expect(await page.locator('#strip li .who').allTextContents()).toEqual(['You', 'You', 'Claude Code', 'GPT reviews', 'You merge']);
    await expect(page.locator('#strip li').nth(1)).toContainText('shaped');
    await expect(page.locator('#strip li').nth(1)).toContainText('auto');
    await expect(page.locator('#strip li').nth(4)).toContainText('Merge');
    await expect(page.locator('.away')).toHaveText('while you’re away');
    await expect(page.locator('.fill.own')).toHaveText('you 22%');
    await expect(page.locator('.fill.agents')).toHaveText('agents 41%');
    await expect(page.locator('#limitLine')).toHaveText('your limit 70%');
    await expect(page.locator('.meter')).toContainText('Claude or OpenAI, any plan');
  });
});

test('with scripts on, the strip plays once in order and the meter grows with it, then it shows the reduced-motion frame and holds still', async ({ browser }) => {
  const reduced = await reducedFrame(browser);
  const context = await browser.newContext({ viewport: DESKTOP });
  try {
    await offlineFonts(context);
    // Sample every frame from the start: when each step shows fully, and how wide the agents' share is.
    await context.addInitScript(() => {
      const log: PlayLog = { arrived: [], widths: [] };
      (window as unknown as { __play: PlayLog }).__play = log;
      addEventListener('DOMContentLoaded', () => {
        const tick = (): void => {
          document.querySelectorAll('#strip li').forEach((li, i) => {
            if (log.arrived[i] === undefined && Number(getComputedStyle(li).opacity) >= 0.99) log.arrived[i] = performance.now();
          });
          const agents = document.querySelector('.fill.agents');
          if (agents) log.widths.push(agents.getBoundingClientRect().width);
          requestAnimationFrame(tick);
        };
        tick();
      });
    });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(base);
    await expect.poll(() => running(page), { timeout: 10_000, message: 'the hero has stopped moving' }).toBe(0);
    const log = await page.evaluate(() => (window as unknown as { __play: PlayLog }).__play);
    expect(log.arrived.length, 'every step arrived').toBe(5);
    expect(log.arrived, 'the steps arrive in order').toEqual([...log.arrived].sort((a, b) => a - b));
    expect(new Set(log.arrived).size, 'one step at a time').toBe(5);
    expect(log.arrived[4]!, 'the last step is in within about four seconds of load').toBeLessThan(5_000);
    const full = log.widths.at(-1)!;
    expect(full).toBeGreaterThan(100);
    expect(log.widths[0], 'the agents begin at nothing, but for the label\'s padding').toBeLessThanOrEqual(12);
    expect(log.widths.some((w) => w > 12 && w < full - 1), 'the agents grow while their steps arrive').toBe(true);
    expect(log.widths, 'the share only grows').toEqual([...log.widths].sort((a, b) => a - b));
    const rested = await endFrame(page);
    expect(rested).toEqual(reduced);
    await page.waitForTimeout(600);
    expect(await running(page), 'nothing moves afterwards').toBe(0);
    expect(await endFrame(page)).toEqual(rested);
    expect(problems, 'page errors').toEqual([]);
  } finally {
    await context.close();
  }
});

test('with scripts off, the five steps and the meter show at their final values', async ({ browser }) => {
  const reduced = await reducedFrame(browser);
  await withPage(browser, { viewport: DESKTOP, javaScriptEnabled: false }, async ({ page }) => {
    expect(await endFrame(page)).toEqual(reduced);
    expect(await page.evaluate(() => document.getAnimations().length), 'nothing animates').toBe(0);
  });
});

test('each copy button puts exactly its command text on the clipboard and shows it was copied', async ({ browser }) => {
  await withPage(browser, { viewport: DESKTOP }, async ({ page, context }) => {
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

test('the install tabs switch the panel, mark the active tab, and move with the arrow keys', async ({ browser }) => {
  await withPage(browser, { viewport: DESKTOP }, async ({ page }) => {
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
    await page.keyboard.press('End');
    await expect(page.locator('#t-agent')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#p-agent')).toBeVisible();
  });
});

test('the keyboard reaches every copy button and each shows a focus ring', async ({ browser }) => {
  await withPage(browser, { viewport: DESKTOP }, async ({ page }) => {
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

test('with scripts off, every command is still on the page', async ({ browser }) => {
  await withPage(browser, { viewport: DESKTOP, javaScriptEnabled: false }, async ({ page }) => {
    await expect(page.locator('#cmdYou')).toBeVisible();
    await expect(page.locator('#cmdYou')).toContainText('npm install -g .');
    await expect(page.locator('#cmdYou')).toContainText('agentsys init --operator you@example.com');
    await expect(page.locator('#cmdAgent')).toBeVisible();
    await expect(page.locator('#cmdAgent')).toContainText('docs/AGENT-SETUP.md');
    await expect(page.locator('.copy').first()).toBeHidden();
  });
});

const FIRST_SCREENS = [
  { name: 'desktop', ...DESKTOP, scale: 1 },
  { name: 'phone', ...PHONE, scale: 2 },
] as const;
const FIRST_SCREEN_DIR = join(process.cwd(), 'test-results', 'site-first-screen');
/** When the page is at rest: later than any motion it plays, so the same wait suits any version of the page. */
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

/** Open the page at rest, in its typefaces, with reduced motion so the end frame shows at once. Close the context even when the body throws. */
async function atRestWithFonts(browser: Browser, options: Parameters<Browser['newContext']>[0], body: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ ...options, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    expect(errors, 'page errors while the first screen loaded').toEqual([]);
    mkdirSync(join(process.cwd(), 'test-results'), { recursive: true });
    await body(page);
  } finally {
    await context.close();
  }
}

test('the first screen at 1200 by 630 is written for the link preview', async ({ browser }) => {
  await atRestWithFonts(browser, { viewport: { width: 1200, height: 630 } }, async (page) => {
    const shot = await page.screenshot({ path: join(process.cwd(), 'test-results', 'site-og.png') });
    expect(shot.readUInt32BE(16)).toBe(1200);
    expect(shot.readUInt32BE(20)).toBe(630);
  });
});

test('the strip and the meter at rest are written for the README', async ({ browser }) => {
  // 1000 wide keeps the five-step layout at about the width GitHub gives the README, so the picture reads at full size.
  await atRestWithFonts(browser, { viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 }, async (page) => {
    const box = await page.locator('#picture').boundingBox();
    expect(box, '#picture has no box').not.toBeNull();
    const pad = 16;
    const clip = { x: box!.x - pad, y: box!.y - pad, width: box!.width + 2 * pad, height: box!.height + 2 * pad };
    const shot = await page.screenshot({ path: join(process.cwd(), 'test-results', 'site-loop.png'), clip });
    expect(Math.abs(shot.readUInt32BE(16) - clip.width * 2), 'width, within the rounding of a fractional clip').toBeLessThanOrEqual(2);
    expect(Math.abs(shot.readUInt32BE(20) - clip.height * 2), 'height, within the rounding of a fractional clip').toBeLessThanOrEqual(2);
  });
});
