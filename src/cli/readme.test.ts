import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
// dist/cli -> dist -> repo root
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'main.js');

const README_PATH = join(repoRoot, 'README.md');
const SETUP_PATH = join(repoRoot, 'docs', 'AGENT-SETUP.md');
const TASKS_PATH = join(repoRoot, 'docs', 'READER-TASKS.md');

/**
 * The README, the agent runbook and the reader-task list are checked against the CLI
 * rather than read for plausibility. A command that was renamed, a flag that was
 * dropped, a link that moved, or a Node version that changed fails here, for anyone
 * who runs `npm test`.
 *
 * Tests whose names start with "fixture:" prove each check on small documents with
 * seeded drift, so a check that stopped catching anything would fail by itself.
 */

// ---- Reading a document ---------------------------------------------------------

const CLI_PREFIX = /^(?:agentsys|node dist\/cli\/main\.js)\s+/;

/** The lines inside each fenced code block of a Markdown document. */
function fencedBlocks(md: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | undefined;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (current) { blocks.push(current); current = undefined; } else { current = []; }
    } else if (current) {
      current.push(line);
    }
  }
  return blocks;
}

/** The document with its fenced code blocks and inline code spans removed. */
function proseOf(md: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) kept.push(line.replace(/`[^`]*`/g, ''));
  }
  return kept.join('\n');
}

/** One logical line of a document: a fenced line, with backslash continuations joined, or a prose line. */
interface Logical { text: string; fenced: boolean }

function logicalLines(md: string): Logical[] {
  const out: Logical[] = [];
  const lines = md.split('\n');
  const isFence = (l: string): boolean => /^\s*```/.test(l);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i]!)) { inFence = !inFence; continue; }
    if (!inFence) { out.push({ text: lines[i]!, fenced: false }); continue; }
    let line = lines[i]!.trim();
    while (line.endsWith('\\') && i + 1 < lines.length && !isFence(lines[i + 1]!)) {
      line = `${line.slice(0, -1).trimEnd()} ${lines[++i]!.trim()}`;
    }
    out.push({ text: line.replace(/\s+#\s.*$/, '').trim(), fenced: true });
  }
  return out;
}

/**
 * Every `agentsys ...` or `node dist/cli/main.js ...` command in a document, in order: lines
 * in fenced blocks (continuations joined, trailing comments dropped) and, unless `fencedOnly`,
 * inline code spans in prose. A span that does not start with the program name, such as
 * `approve --task`, is not one. A fenced line is a whole command; an inline span may name only
 * part of one, so only fenced lines are candidates to run.
 */
function commandLines(md: string, fencedOnly = false): string[] {
  const out: string[] = [];
  for (const { text, fenced } of logicalLines(md)) {
    if (fenced) {
      if (CLI_PREFIX.test(text)) out.push(text);
    } else if (!fencedOnly) {
      for (const m of text.matchAll(/`([^`]+)`/g)) if (CLI_PREFIX.test(m[1]!.trim())) out.push(m[1]!.trim());
    }
  }
  return out;
}

/** Every command line in the fenced blocks of a document, whatever program it runs. */
function shellLines(md: string): string[] {
  return logicalLines(md).filter((l) => l.fenced && l.text !== '' && !l.text.startsWith('#')).map((l) => l.text);
}

/** The text under the first heading whose title matches, up to the next heading of the same or higher level. */
function sectionOf(md: string, title: RegExp): string | undefined {
  const lines = md.split('\n');
  let level = 0;
  const body: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = inFence ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (level === 0) {
      if (heading && title.test(heading[2]!)) level = heading[1]!.length;
    } else if (heading && heading[1]!.length <= level) {
      break;
    } else {
      body.push(line);
    }
  }
  return level === 0 ? undefined : body.join('\n');
}

/** GitHub's anchor for each heading: lower case, punctuation removed, spaces to hyphens, repeats suffixed. */
function headingSlugs(md: string): Set<string> {
  const slugs = new Set<string>();
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    const m = inFence ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const slug = m[1]!.toLowerCase().replace(/<[^>]+>/g, '').replace(/`/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    slugs.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return slugs;
}

// ---- Commands against the CLI ----------------------------------------------------

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `agentsys --help` split into one usage block per command (a command may appear on several lines). */
function helpSections(help: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | undefined;
  for (const line of help.split('\n')) {
    const head = /^ {2}([a-z][a-z-]*)(?:\s|$)/.exec(line);
    if (head) {
      current = head[1]!;
      sections.set(current, `${sections.get(current) ?? ''}${line}\n`);
    } else if (current && /^ {3,}\S/.test(line)) {
      sections.set(current, `${sections.get(current)}${line}\n`);
    } else {
      current = undefined;
    }
  }
  return sections;
}

const argvOf = (line: string): string[] =>
  line.replace(CLI_PREFIX, '').replace(/"[^"]*"|'[^']*'/g, '""').trim().split(/\s+/);

/** One problem per documented command whose subcommand or flag the CLI does not advertise. */
function commandProblems(lines: string[], sections: Map<string, string>, extraUsage: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const line of lines) {
    const argv = argvOf(line);
    const sub = argv[0]!;
    if (sub === '--help') continue;
    const usage = sections.get(sub);
    if (usage === undefined) {
      problems.push(`${line}\n    no command "${sub}" in \`agentsys --help\``);
      continue;
    }
    const known = usage + (extraUsage.get(sub) ?? '');
    for (const token of argv.filter((t) => /^--[a-z]/.test(t))) {
      const flag = token.split('=')[0]!;
      if (!new RegExp(`(?<![\\w-])${escapeRe(flag)}(?![\\w-])`).test(known)) {
        problems.push(`${line}\n    "${sub}" has no ${flag} in its usage`);
      }
    }
  }
  return problems;
}

/** `agentsys grant` keeps its flags in its own usage text, not in `--help`. */
async function cliUsage(): Promise<{ sections: Map<string, string>; extra: Map<string, string> }> {
  const help = (await run(process.execPath, [CLI, '--help'], { timeout: 60_000 })).stdout;
  const grant = (await run(process.execPath, [CLI, 'grant'], { timeout: 60_000 })).stdout;
  return { sections: helpSections(help), extra: new Map([['grant', grant]]) };
}

// ---- Running documented commands for real ----------------------------------------

/**
 * The closed set of documented commands the check may execute. Each one only reads, or
 * writes to the temporary state directory, and none needs a vendor account. Anything
 * else — `usage` above all, which prints a real account id, and any dispatch that
 * carries an approval or a grant — is checked against the CLI's usage text but never run.
 */
function isSafeToRun(line: string): boolean {
  const argv = argvOf(line);
  const [sub, second] = argv;
  const flags = argv.filter((t) => t.startsWith('--'));
  switch (sub) {
    case 'init': return flags.every((f) => f === '--operator');
    case 'readiness': return flags.every((f) => f === '--runtime');
    case 'status': return flags.every((f) => f === '--task');
    case 'approvals': return argv.length === 1;
    case 'ledger': return argv.length === 1 || (argv.length === 2 && second === 'show');
    case 'floor': return flags.length === 1 && flags[0] === '--show';
    case 'config': return flags.length === 1 && flags[0] === '--show';
    case 'grant': return second === 'list';
    case 'policy': return flags.includes('--show') && !flags.includes('--as');
    case 'dispatch': return !flags.includes('--approval') && !flags.includes('--trigger-source');
    default: return false;
  }
}

interface Ran { code: number; stdout: string; stderr: string }

async function runDocumented(line: string, state: string): Promise<Ran> {
  const argv = line.replace(CLI_PREFIX, '').match(/"[^"]*"|'[^']*'|\S+/g)!
    .map((t) => t.replace(/^(["'])(.*)\1$/, '$2'));
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...argv], {
      env: { ...process.env, AGENTSYS_STATE: state },
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const RUNTIMES = ['pi-local', 'codex-cloud', 'claude-web', 'claude-local'];

/** What a documented command must print on a fresh state directory, and nothing more than that. */
function resultProblems(line: string, ran: Ran): string[] {
  const argv = argvOf(line);
  const sub = argv[0]!;
  const out = `${ran.stdout}${ran.stderr}`;
  const problems: string[] = [];
  const expect = (ok: boolean, what: string): void => { if (!ok) problems.push(`${line}\n    ${what} (exit ${ran.code})`); };
  switch (sub) {
    case 'init':
      expect(ran.code === 0 && /No autonomy grants are active/.test(out), 'init should exit 0 and say no grants are active');
      break;
    case 'readiness': {
      const asked = argv.includes('--runtime') ? [argv[argv.indexOf('--runtime') + 1]!] : RUNTIMES;
      expect(ran.code === 0 || ran.code === 1, 'readiness should exit 0 or 1');
      for (const rt of asked) expect(new RegExp(`^${escapeRe(rt)}: (ready|NOT READY)`, 'm').test(out), `readiness should report ${rt}`);
      break;
    }
    case 'status':
      expect(ran.code === 0 && /No runs recorded/.test(out), 'status on a fresh state should say no runs are recorded');
      break;
    case 'dispatch':
      expect(ran.code === 1 && /Awaiting approval/.test(out) && /there are no grants/.test(out),
        'a dispatch with no approval should exit 1 and be held for approval');
      break;
    default:
      expect(ran.code === 0, `${sub} should exit 0`);
  }
  return problems;
}

async function documentedRunProblems(lines: string[]): Promise<string[]> {
  const state = mkdtempSync(join(tmpdir(), 'agentsys-readme-'));
  const problems: string[] = [];
  try {
    for (const line of lines.filter(isSafeToRun)) problems.push(...resultProblems(line, await runDocumented(line, state)));
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
  return problems;
}

/** A listing of a directory tree with modification times, to show a run left it alone. */
function snapshot(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const rows: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    rows.push(`${path} ${statSync(path).mtimeMs}`);
  }
  return rows.sort().join('\n');
}

// ---- Links and versions ----------------------------------------------------------

/** One problem per relative link, image or anchor that does not resolve. */
function linkProblems(docPath: string, md: string): string[] {
  const problems: string[] = [];
  const own = headingSlugs(md);
  for (const m of proseOf(md).matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1]!;
    if (/^(?:[a-z][a-z0-9+.-]*:)/i.test(target)) continue;
    const [path, anchor] = target.split('#') as [string, string | undefined];
    const file = path === '' ? docPath : resolve(dirname(docPath), path);
    if (path !== '' && !existsSync(file)) { problems.push(`${target}\n    no such file: ${file.replace(`${repoRoot}/`, '')}`); continue; }
    if (anchor === undefined || anchor === '' || !file.endsWith('.md')) continue;
    const slugs = file === docPath ? own : headingSlugs(readFileSync(file, 'utf8'));
    if (!slugs.has(decodeURIComponent(anchor))) problems.push(`${target}\n    no heading "${anchor}" in ${file.replace(`${repoRoot}/`, '')}`);
  }
  return problems;
}

function nodeVersionProblems(readme: string, engines: string): string[] {
  const min = /(\d+(?:\.\d+)*)/.exec(engines)?.[1];
  if (!min) return [`package.json engines.node "${engines}" has no version`];
  return new RegExp(`Node(?:\\.js)?[^\\n]{0,40}${escapeRe(min)}`).test(readme)
    ? []
    : [`README does not state Node ${min}, the minimum in package.json engines.node ("${engines}")`];
}

// ---- Reader tasks ----------------------------------------------------------------

const STATUS = /^(?:unverified|verified \(\d{4}-\d{2}-\d{2}\)(?:; not driven: .+)?|stale \(\d{4}-\d{2}-\d{2}\): .+)$/;
const TASK_FIELDS = ['Reader', 'Documents', 'Ends up able to', 'Status'];

/** One problem per reader-task entry that misses a field, repeats an id, names no document, or has a status the list does not define. */
function readerTaskProblems(md: string): string[] {
  const problems: string[] = [];
  const entries = md.split(/^### /m).slice(1).filter((e) => /^T\d+ — /.test(e));
  if (entries.length === 0) return ['no reader-task entries ("### T1 — Title")'];
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = /^(T\d+)/.exec(entry)![1]!;
    if (ids.has(id)) problems.push(`${id}: listed twice`);
    ids.add(id);
    const fields = new Map<string, string>();
    for (const m of entry.matchAll(/^- \*\*(.+?):\*\* (.+)$/gm)) fields.set(m[1]!, m[2]!.trim());
    for (const name of TASK_FIELDS) if (!fields.get(name)) problems.push(`${id}: missing field "${name}"`);
    const status = fields.get('Status');
    if (status !== undefined && !STATUS.test(status)) problems.push(`${id}: invalid status "${status}"`);
    if (fields.has('Documents') && !/\]\([^)]+\)/.test(fields.get('Documents')!)) problems.push(`${id}: Documents names no linked document`);
  }
  return problems;
}

// ---- Fixtures: each check catches seeded drift ----------------------------------

const FIXTURE_USAGE = helpSections([
  'agentsys — fixture',
  '',
  '  init      --operator <id>',
  '  status    [--task <id>] | --repo <path>',
  '  loop      --repo <path> [--once]',
  '  usage     [--runtime <rt>]',
].join('\n'));

describe('the documented-command check catches drift', () => {
  it('fixture: real commands pass', () => {
    const md = ['```bash', 'agentsys init --operator you@example.com   # name the operator', 'node dist/cli/main.js status --task t1', '```', 'Run `agentsys --help` to list them.'].join('\n');
    assert.deepEqual(commandProblems(commandLines(md), FIXTURE_USAGE, new Map()), []);
  });

  it('fixture: an unknown subcommand fails and names the line', () => {
    const md = ['```', 'agentsys launch --repo a/b', '```'].join('\n');
    const problems = commandProblems(commandLines(md), FIXTURE_USAGE, new Map());
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /agentsys launch --repo a\/b/);
    assert.match(problems[0]!, /no command "launch"/);
  });

  it('fixture: an unknown flag fails, and a longer flag does not stand in for a shorter one', () => {
    const md = ['```', 'agentsys init --operator me --force', 'agentsys loop --repos ~/src/x', '```'].join('\n');
    const problems = commandProblems(commandLines(md), FIXTURE_USAGE, new Map());
    assert.equal(problems.length, 2);
    assert.match(problems[0]!, /"init" has no --force/);
    assert.match(problems[1]!, /"loop" has no --repos/);
  });

  it('fixture: continuations and trailing comments are read as the command they are', () => {
    const md = [
      '```',
      'agentsys loop --repo ~/src/x \\',
      '  --once   # one pass',
      '# agentsys bogus',
      'npm run build',
      '```',
    ].join('\n');
    assert.deepEqual(commandLines(md), ['agentsys loop --repo ~/src/x --once']);
    assert.deepEqual(shellLines(md), ['agentsys loop --repo ~/src/x --once', 'npm run build']);
  });

  it('fixture: an inline command in prose is checked in document order, and a span without the program name is not a command', () => {
    const md = ['Run `agentsys status` first.', '```', 'agentsys init --operator me', '```', 'Not `approve --task <id>`, and not `npm ci`.'].join('\n');
    assert.deepEqual(commandLines(md), ['agentsys status', 'agentsys init --operator me']);
    assert.deepEqual(commandLines(md, true), ['agentsys init --operator me']);
    const problems = commandProblems(commandLines('See `agentsys bogus --x`.'), FIXTURE_USAGE, new Map());
    assert.equal(problems.length, 1);
  });
});

describe('the documented-command runner executes only what it may', () => {
  it('fixture: a documented command outside the closed set is never executed', () => {
    assert.equal(isSafeToRun('agentsys usage'), false);
    assert.equal(isSafeToRun('agentsys usage --runtime claude-local'), false);
    assert.equal(isSafeToRun('agentsys dispatch --task t --approval apv_1 --prompt x'), false);
    assert.equal(isSafeToRun('agentsys dispatch --task t --trigger-source s --prompt x'), false);
    assert.equal(isSafeToRun('agentsys approve --as me --repo a/b'), false);
    assert.equal(isSafeToRun('agentsys grant create --as me'), false);
    assert.equal(isSafeToRun('agentsys loop arm --repo ~/src/x'), false);
  });

  it('fixture: documented first-run commands are executed, in a temp state, and leave the real one alone', async () => {
    const realState = process.env['AGENTSYS_STATE'];
    const before = snapshot(join(repoRoot, '.state'));
    const problems = await documentedRunProblems([
      'agentsys init --operator you@example.com',
      'agentsys status',
      'agentsys dispatch --task t1 --repo example-org/larkspur --class ci-repair --runtime pi-local --profile default --actions author-changes --estimate-five-hour 1 --estimate-weekly 1 --estimate-basis operator-bound --prompt "should not run"',
      'agentsys usage',
    ]);
    assert.deepEqual(problems, []);
    assert.equal(snapshot(join(repoRoot, '.state')), before, 'the repository .state directory changed');
    assert.equal(process.env['AGENTSYS_STATE'], realState);
  });

  it('fixture: a documented result that differs from what the CLI prints fails', async () => {
    const wrong = resultProblems('agentsys status', { code: 1, stdout: 'Error', stderr: '' });
    assert.equal(wrong.length, 1);
    assert.match(wrong[0]!, /status on a fresh state/);
  });
});

describe('the link and version checks catch drift', () => {
  const docPath = join(repoRoot, 'docs', 'FIXTURE.md');

  it('fixture: links to files and headings that exist pass', () => {
    const md = ['# Title', '', '## Quick start', '', '[readme](../README.md)', '[here](#quick-start)', '[site](https://example.com/x)'].join('\n');
    assert.deepEqual(linkProblems(docPath, md), []);
  });

  it('fixture: a missing file fails', () => {
    const problems = linkProblems(docPath, '[gone](../no-such-file.md)');
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /no such file/);
  });

  it('fixture: a missing heading fails', () => {
    const problems = linkProblems(docPath, '# Title\n\n[x](#not-a-heading) [y](../README.md#not-a-heading)');
    assert.equal(problems.length, 2);
    assert.match(problems[0]!, /no heading "not-a-heading"/);
  });

  it('fixture: links inside code are not links', () => {
    assert.deepEqual(linkProblems(docPath, '```\n[x](missing.md)\n```\nSee `[y](missing.md)`.'), []);
  });

  it('fixture: a README that states a different Node version fails', () => {
    assert.deepEqual(nodeVersionProblems('**Node.js ≥ 22.12**', '>=22.12'), []);
    const problems = nodeVersionProblems('Needs Node.js 20 or newer.', '>=22.12');
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /does not state Node 22\.12/);
  });
});

describe('the reader-task check catches drift', () => {
  const entry = (status: string, extra = ''): string => [
    '### T1 — Decide fit', '',
    '- **Reader:** A developer.',
    '- **Documents:** [README.md](../README.md)',
    '- **Ends up able to:** Say what it does.',
    `- **Status:** ${status}`,
    extra,
  ].join('\n');

  it('fixture: a complete entry passes, with each of the three statuses', () => {
    for (const status of ['unverified', 'verified (2026-10-14)', 'verified (2026-10-14); not driven: Codex cloud, no environment', 'stale (2026-10-14): the quick start moved']) {
      assert.deepEqual(readerTaskProblems(entry(status)), [], status);
    }
  });

  it('fixture: an invalid status fails', () => {
    const problems = readerTaskProblems(entry('done'));
    assert.deepEqual(problems, ['T1: invalid status "done"']);
  });

  it('fixture: a missing field fails and names it', () => {
    const problems = readerTaskProblems(entry('unverified').replace(/^- \*\*Reader:\*\* .*\n/m, ''));
    assert.deepEqual(problems, ['T1: missing field "Reader"']);
  });

  it('fixture: an entry that links no document fails', () => {
    const problems = readerTaskProblems(entry('unverified').replace('[README.md](../README.md)', 'README.md'));
    assert.deepEqual(problems, ['T1: Documents names no linked document']);
  });

  it('fixture: a repeated id and a file with no entries fail', () => {
    assert.deepEqual(readerTaskProblems(`${entry('unverified')}\n${entry('unverified')}`), ['T1: listed twice']);
    assert.equal(readerTaskProblems('# Reader tasks\n\nNothing here.').length, 1);
  });
});

// ---- The real documents ----------------------------------------------------------

const read = (path: string): string => readFileSync(path, 'utf8');

describe('the documents match the CLI they describe', () => {
  for (const [name, path] of [['README.md', README_PATH], ['docs/AGENT-SETUP.md', SETUP_PATH]] as const) {
    it(`every ${name} command exists, with the flags it uses`, async () => {
      const lines = commandLines(read(path));
      assert.ok(lines.length > 0, `${name} documents no agentsys command`);
      const { sections, extra } = await cliUsage();
      assert.deepEqual(commandProblems(lines, sections, extra), []);
    });

    it(`the safe ${name} commands run for real in a temp state and print what the document says`, async () => {
      const lines = commandLines(read(path), true);
      assert.ok(lines.some(isSafeToRun), `${name} documents no command the check can run`);
      assert.deepEqual(await documentedRunProblems(lines), []);
    });
  }

  it('every README quick-start command appears verbatim in the agent runbook', () => {
    const quickStart = sectionOf(read(README_PATH), /^Quick start$/i);
    assert.ok(quickStart, 'README has no "Quick start" section');
    const wanted = shellLines(quickStart);
    assert.ok(wanted.length > 0, 'README quick start holds no command');
    const have = new Set(shellLines(read(SETUP_PATH)).map((l) => l.replace(/\s+/g, ' ')));
    const missing = wanted.filter((l) => !have.has(l.replace(/\s+/g, ' ')));
    assert.deepEqual(missing, [], 'in README quick start but not in docs/AGENT-SETUP.md');
  });
});

describe('the documents link only to what exists', () => {
  for (const [name, path] of [['README.md', README_PATH], ['docs/AGENT-SETUP.md', SETUP_PATH], ['docs/READER-TASKS.md', TASKS_PATH]] as const) {
    it(`every link and image in ${name} resolves`, () => {
      assert.deepEqual(linkProblems(path, read(path)), []);
    });
  }

  it('the README states the Node version package.json requires', () => {
    const pkg = JSON.parse(read(join(repoRoot, 'package.json'))) as { engines: { node: string } };
    assert.deepEqual(nodeVersionProblems(read(README_PATH), pkg.engines.node), []);
  });
});

describe('the README points to the page and to the agent runbook', () => {
  const readme = read(README_PATH);

  it('links the explainer page', () => {
    assert.ok(readme.includes('https://mocraimer.github.io/agent-system/'), 'README does not link the explainer page');
  });

  it('has a section for a coding agent that holds a paste-ready prompt naming the runbook', () => {
    const section = sectionOf(readme, /coding agent/i);
    assert.ok(section, 'README has no section about a coding agent');
    const prompts = fencedBlocks(section).filter((block) => block.join('\n').includes('docs/AGENT-SETUP.md'));
    assert.ok(prompts.length > 0, 'no fenced prompt in that section names docs/AGENT-SETUP.md');
    assert.match(section, /\]\([^)]*AGENT-SETUP\.md\)/, 'that section does not link docs/AGENT-SETUP.md');
  });
});

describe('the reader-task list is well formed', () => {
  it('every entry has its fields, a valid status and a linked document', () => {
    assert.deepEqual(readerTaskProblems(read(TASKS_PATH)), []);
  });
});
