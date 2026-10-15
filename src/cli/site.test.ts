import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { escapeRe, headingSlugs } from './docs-testkit.js';

// dist/cli -> dist -> repo root
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(repoRoot, 'site');
const PAGES_URL = 'https://mocraimer.github.io/agent-system/';
const REPO_URL = 'https://github.com/mocraimer/agent-system';
const RAW_URL = 'https://raw.githubusercontent.com/mocraimer/agent-system/main/';
/** The only hosts outside the site that the page may load a resource from: they serve its three typefaces. */
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

const read = (path: string): string => readFileSync(path, 'utf8');
const html = (): string => read(join(SITE, 'index.html'));

/**
 * The explainer page is checked as static text, so these checks run in CI without a
 * browser: it loads nothing it should not, its commands are the README's, its images are
 * the console screenshots, and every link it gives points at a file and heading that exist.
 * `ui-tests/site.spec.ts` checks how the page behaves in a browser.
 *
 * Tests named with "fixture:" prove a check catches seeded drift.
 */

// ---- Helpers ---------------------------------------------------------------------

const decode = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** The text of the element with this id, as the browser would copy it. */
function textOfId(page: string, id: string): string | undefined {
  const m = new RegExp(`<([a-z]+)[^>]*\\bid="${escapeRe(id)}"[^>]*>([\\s\\S]*?)</\\1>`).exec(page);
  return m ? decode(m[2]!.replace(/<[^>]+>/g, '')) : undefined;
}

/** Absolute URLs the page asks the browser to load: stylesheets, scripts, images, frames, CSS url() and @import. */
function loadedUrls(page: string): string[] {
  const urls: string[] = [];
  for (const m of page.matchAll(/<link\b[^>]*>/g)) {
    if (/rel="canonical"/.test(m[0])) continue;
    const href = /\bhref="([^"]+)"/.exec(m[0])?.[1];
    if (href) urls.push(href);
  }
  for (const m of page.matchAll(/<(?:script|img|source|iframe|video|audio|embed)\b[^>]*\bsrc="([^"]+)"/g)) urls.push(m[1]!);
  for (const m of page.matchAll(/url\(\s*['"]?([^'")\s]+)/g)) urls.push(m[1]!);
  for (const m of page.matchAll(/@import\s+(?:url\()?['"]?([^'")\s;]+)/g)) urls.push(m[1]!);
  return urls.filter((u) => !u.startsWith('data:'));
}

function loadProblems(page: string): string[] {
  const problems: string[] = [];
  if (/<script\b[^>]*\bsrc=/.test(page)) problems.push('a <script src> loads code from a file or a host');
  if (/type="importmap"/.test(page)) problems.push('an import map');
  if (/webgl/i.test(page)) problems.push('WebGL');
  if (/analytics|gtag|googletagmanager|plausible|hotjar|segment\.(?:com|io)/i.test(page)) problems.push('analytics or tracking');
  for (const url of loadedUrls(page)) {
    if (/^https?:\/\//.test(url)) {
      const host = new URL(url).host;
      if (!FONT_HOSTS.has(host)) problems.push(`loads from ${host}`);
    } else if (url.startsWith('/') || url.startsWith('//')) {
      problems.push(`${url} is not a relative URL`);
    } else if (!url.startsWith('#') && !existsSync(join(SITE, url.split(/[?#]/)[0]!))) {
      problems.push(`${url} does not exist in site/`);
    }
  }
  for (const m of page.matchAll(/<img\b[^>]*>/g)) {
    if (!/\balt="[^"]+"/.test(m[0])) problems.push(`an <img> without alt text: ${m[0].slice(0, 60)}`);
  }
  return problems;
}

/** One problem per link into this repository whose file or heading does not exist. */
function repoLinkProblems(text: string): string[] {
  const problems: string[] = [];
  const check = (path: string, anchor: string | undefined, link: string): void => {
    const file = join(repoRoot, path);
    if (!existsSync(file)) { problems.push(`${link}\n    no such file: ${path}`); return; }
    // GitHub gives the rendered README the id "readme"; it is not a heading.
    if (anchor === 'readme' && path === 'README.md') return;
    if (anchor && file.endsWith('.md') && !headingSlugs(read(file)).has(anchor)) problems.push(`${link}\n    no heading "${anchor}" in ${path}`);
  };
  for (const m of text.matchAll(/https:\/\/github\.com\/mocraimer\/agent-system(?:\/(?:blob|tree)\/main\/([^"'#)\s]+))?(?:#([\p{L}\p{N}_-]+))?/gu)) {
    check(m[1] ?? 'README.md', m[2], m[0]);
  }
  for (const m of text.matchAll(/https:\/\/raw\.githubusercontent\.com\/mocraimer\/agent-system\/main\/([^"'#)\s]+)/g)) check(m[1]!, undefined, m[0]);
  return problems;
}

/** Width and height from the IHDR chunk, or undefined when the bytes are not a PNG header. */
const pngSize = (bytes: Buffer): { width: number; height: number } | undefined =>
  bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    : undefined;

// ---- Fixtures --------------------------------------------------------------------

describe('the static-page checks catch drift', () => {
  const GOOD = '<html><head><link href="https://fonts.googleapis.com/css2?family=X" rel="stylesheet"><link rel="canonical" href="https://example.com/"></head><body><img src="assets/inbox.png" alt="Inbox"></body></html>';

  it('fixture: a page that loads only fonts and local files passes', () => {
    assert.deepEqual(loadProblems(GOOD), []);
  });

  it('fixture: a script file, an unknown host, a rooted path and a missing file each fail', () => {
    assert.match(loadProblems('<script src="app.js"></script>').join('\n'), /<script src>/);
    assert.match(loadProblems('<link href="https://cdn.example.com/x.css" rel="stylesheet">').join('\n'), /loads from cdn\.example\.com/);
    assert.match(loadProblems('<img src="/assets/inbox.png" alt="x">').join('\n'), /not a relative URL/);
    assert.match(loadProblems('<img src="assets/nope.png" alt="x">').join('\n'), /does not exist in site\//);
    assert.match(loadProblems('<style>a{background:url(https://cdn.example.com/a.png)}</style>').join('\n'), /loads from cdn\.example\.com/);
  });

  it('fixture: WebGL, an import map, tracking and an image without alt text each fail', () => {
    assert.match(loadProblems('<canvas></canvas><script>c.getContext("webgl")</script>').join('\n'), /WebGL/);
    assert.match(loadProblems('<script type="importmap">{}</script>').join('\n'), /import map/);
    assert.match(loadProblems('<script>gtag("config")</script>').join('\n'), /analytics/);
    assert.match(loadProblems('<img src="assets/inbox.png">').join('\n'), /without alt text/);
  });

  it('fixture: a link into the repository to a missing file or heading fails', () => {
    assert.deepEqual(repoLinkProblems(`${REPO_URL}/blob/main/docs/OPERATING.md#approving-one-task ${REPO_URL}#quick-start ${REPO_URL}#readme`), []);
    assert.match(repoLinkProblems(`${REPO_URL}/blob/main/docs/NOPE.md`).join('\n'), /no such file/);
    assert.match(repoLinkProblems(`${REPO_URL}/blob/main/docs/OPERATING.md#nope`).join('\n'), /no heading "nope"/);
    assert.match(repoLinkProblems(`${RAW_URL}docs/NOPE.md`).join('\n'), /no such file/);
  });

  it('fixture: the text of a copy block is read as the browser would copy it', () => {
    assert.equal(textOfId('<pre id="c">a &lt;path&gt; &amp; "b"\nnext</pre>', 'c'), 'a <path> & "b"\nnext');
    assert.equal(textOfId('<pre id="c">x</pre>', 'missing'), undefined);
  });

  it('fixture: a PNG header is read, and a non-PNG is refused', () => {
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
    header.writeUInt32BE(1200, 16);
    header.writeUInt32BE(630, 20);
    assert.deepEqual(pngSize(header), { width: 1200, height: 630 });
    assert.equal(pngSize(Buffer.from('GIF89a')), undefined);
    assert.equal(pngSize(header.subarray(0, 16)), undefined, 'a header cut short is not read past its end');
  });
});

// ---- The page --------------------------------------------------------------------

describe('the explainer page loads only what it should', () => {
  it('is one HTML file with inline styles and script, no library, no WebGL, and only font hosts outside the site', () => {
    assert.deepEqual(loadProblems(html()), []);
  });

  it('has a language, a title, a description and a viewport', () => {
    const page = html();
    assert.match(page, /<html lang="[a-z-]+"/);
    assert.match(page, /<title>[^<]+<\/title>/);
    assert.match(page, /<meta name="description" content="[^"]+"/);
    assert.match(page, /<meta name="viewport" content="[^"]*width=device-width/);
  });

  it('carries Open Graph and Twitter tags, with an og:image on the Pages address', () => {
    const page = html();
    for (const prop of ['og:title', 'og:description', 'og:url', 'og:image']) assert.match(page, new RegExp(`<meta property="${prop}" content="[^"]+"`), prop);
    for (const name of ['twitter:card', 'twitter:title', 'twitter:image']) assert.match(page, new RegExp(`<meta name="${name}" content="[^"]+"`), name);
    assert.ok(page.includes(`<meta property="og:url" content="${PAGES_URL}">`), 'og:url is not the Pages address');
    assert.ok(page.includes(`<meta property="og:image" content="${PAGES_URL}og.png">`), 'og:image is not og.png on the Pages address');
  });

  it('has an og.png of 1200 by 630 pixels', () => {
    assert.deepEqual(pngSize(readFileSync(join(SITE, 'og.png'))), { width: 1200, height: 630 });
  });
});

describe('the page says what the README says', () => {
  const readme = read(join(repoRoot, 'README.md'));

  it('copies the README quick start exactly, as text in the HTML', () => {
    const block = /## Quick start\n\n```bash\n([\s\S]*?)\n```/.exec(readme)?.[1];
    assert.ok(block, 'README has no quick-start block');
    assert.equal(textOfId(html(), 'cmdYou'), block);
  });

  it("copies the README's paste-ready prompt exactly, as text in the HTML", () => {
    const block = /## Set it up with a coding agent[\s\S]*?```text\n([\s\S]*?)\n```/.exec(readme)?.[1];
    assert.ok(block, 'README has no paste-ready prompt');
    assert.equal(textOfId(html(), 'cmdAgent'), block);
  });

  it('shows only commands that the README or the agent guide shows', () => {
    const known = new Set<string>();
    const collect = (md: string): void => {
      for (const m of md.matchAll(/`((?:agentsys|node dist\/cli\/main\.js)[^`]*)`/g)) known.add(m[1]!.trim());
      for (const block of md.matchAll(/```[a-z]*\n([\s\S]*?)\n```/g)) {
        for (const line of block[1]!.replace(/\\\n\s*/g, ' ').split('\n')) known.add(line.replace(/\s+#\s.*$/, '').replace(/\s+/g, ' ').trim());
      }
    };
    collect(readme);
    collect(read(join(repoRoot, 'docs', 'AGENT-SETUP.md')));
    const page = html();
    const shown = [
      ...[...page.matchAll(/<span class="ln c">([\s\S]*?)<\/span>/g)].map((m) => decode(m[1]!)),
      ...[...page.matchAll(/<code>((?:agentsys|node dist\/cli\/main\.js) [^<]*)<\/code>/g)].map((m) => decode(m[1]!)),
      ...[...page.matchAll(/<div class="how">([\s\S]*?)<\/div>/g)].flatMap((m) => [...m[1]!.matchAll(/<span>([^<]+)<\/span>/g)].map((s) => decode(s[1]!))),
    ].map((c) => c.replace(/\\\n\s*/g, ' ').replace(/\s+/g, ' ').trim());
    assert.ok(shown.length > 8, `expected the page to show its commands, found ${shown.length}`);
    assert.deepEqual(shown.filter((c) => !known.has(c)), [], 'on the page but not in the README or docs/AGENT-SETUP.md');
  });

  it('keeps no screenshot that docs/console-screens does not hold', () => {
    const sources = new Set(readdirSync(join(repoRoot, 'docs', 'console-screens')));
    const strays = readdirSync(join(SITE, 'assets')).filter((f) => !sources.has(f));
    assert.deepEqual(strays, [], 'in site/assets but not in docs/console-screens');
  });

  it('shows the console screenshots byte for byte', () => {
    const shots = readdirSync(join(repoRoot, 'docs', 'console-screens')).filter((f) => f.endsWith('.png'));
    assert.ok(shots.length > 0);
    for (const shot of shots) {
      const copy = join(SITE, 'assets', shot);
      assert.ok(existsSync(copy), `site/assets/${shot} is missing. Run: cp docs/console-screens/*.png site/assets/`);
      assert.ok(readFileSync(copy).equals(readFileSync(join(repoRoot, 'docs', 'console-screens', shot))),
        `site/assets/${shot} differs from docs/console-screens/${shot}. Run: cp docs/console-screens/*.png site/assets/`);
    }
  });

  it('links only to files and headings in this repository that exist', () => {
    assert.deepEqual(repoLinkProblems(html()), []);
  });
});

describe('llms.txt lists what an agent can read', () => {
  const text = (): string => read(join(SITE, 'llms.txt'));

  it('starts with a title and a summary, then sections of linked notes', () => {
    const t = text();
    assert.match(t, /^# agent-system\n\n> .+/);
    assert.match(t, /\n## [^\n]+\n\n(?:- \[[^\]]+\]\([^)]+\): [^\n]+\n)+/);
    const stray = t.split('\n').filter((l) => l !== '' && !/^(?:# |> |## |- \[[^\]]+\]\([^)]+\): .+)/.test(l));
    assert.deepEqual(stray, [], 'lines that are not a title, summary, section or linked note');
  });

  it('links only to the page and to raw files that exist in the repository', () => {
    const urls = [...text().matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!);
    assert.ok(urls.length >= 5, 'llms.txt lists too few documents');
    const foreign = urls.filter((u) => u !== PAGES_URL && !u.startsWith(RAW_URL));
    assert.deepEqual(foreign, [], 'URLs that are neither the page nor a raw file in this repository');
    assert.deepEqual(repoLinkProblems(text()), []);
  });
});
