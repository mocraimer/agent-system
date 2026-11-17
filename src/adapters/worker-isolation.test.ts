import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import { ClaudeLocalAdapter } from './claude-local.js';
import { PiAdapter } from './pi.js';
import type { DispatchInput, DispatchResult } from './types.js';

/**
 * A worker is a process the coordinator starts to do a task on this machine. It
 * must not be able to read or write the coordinator's state: a worker that runs
 * `agentsys status` or a recipe on a ticket for this very repository would
 * otherwise act on the live ledger, authority and runs. Each test names the
 * coordinator's state as a sentinel directory and lets a stub worker try to
 * reach it the way a real one would.
 */

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'main.js');

const scratch: string[] = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

/**
 * Every file under a directory with its digest, so "unchanged" means byte for byte.
 * The adapter's own pid bookkeeping (`claude-local/sessions`) is the coordinator's
 * write, not a worker's, so it is left out.
 */
function digest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (relative(root, path) === 'claude-local') continue;
      if (statSync(path).isDirectory()) { out[`${relative(root, path)}/`] = 'dir'; walk(path); }
      else out[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root);
  return out;
}

/**
 * The worker's side of the check, written once and run by each stub: report which
 * state directory it was given, run the built CLI against it, and try to write
 * under it.
 */
const workerBody = (report: string): string[] => [
  "const { spawnSync } = require('node:child_process');",
  "const { mkdirSync, writeFileSync } = require('node:fs');",
  "const { join } = require('node:path');",
  'const state = process.env.AGENTSYS_STATE;',
  `const status = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'status'], { encoding: 'utf8' });`,
  'let wrote = null;',
  "try { mkdirSync(join(state, 'runs'), { recursive: true }); writeFileSync(join(state, 'runs', 'worker-wrote.json'), '{}'); wrote = true; } catch (err) { wrote = String(err); }",
  `writeFileSync(${JSON.stringify(report)}, JSON.stringify({ state, statusExit: status.status, wrote }));`,
];

function stubDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

interface WorkerReport { state: string | undefined; statusExit: number | null; wrote: true | string | null }

function readReport(path: string): WorkerReport {
  assert.ok(existsSync(path), 'the stub worker ran and reported');
  return JSON.parse(readFileSync(path, 'utf8')) as WorkerReport;
}

function claudeCase(): { adapter: ClaudeLocalAdapter; input: DispatchInput; report: string } {
  const dir = stubDir('worker-claude-');
  const report = join(dir, 'report.json');
  const bin = join(dir, 'claude');
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    "if (process.argv[2] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: true })); process.exit(0); }",
    ...workerBody(report),
    "process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 's', modelUsage: { 'claude-opus-5-5': {} } }));",
  ].join('\n'), 'utf8');
  chmodSync(bin, 0o755);
  const noUsage = { readUsage: () => Promise.reject(new Error('unused')) };
  return {
    adapter: new ClaudeLocalAdapter(bin, noUsage as never),
    report,
    input: {
      taskId: 'task-claude', runId: 'run-claude', task: 'Work the ticket.', repoPath: dir,
      evidenceDir: join(dir, 'evidence'), settings: {}, entry: 'prompt', actions: ['review'],
    },
  };
}

function piCase(): { adapter: PiAdapter; input: DispatchInput; report: string } {
  const dir = stubDir('worker-pi-');
  const report = join(dir, 'report.json');
  const skillDir = join(dir, 'claude-plugins/manifest-dev/skills/auto');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), 'Protocol fixture', 'utf8');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'protocol-fixture', version: '1.0.0' }));
  const bin = join(dir, 'pi');
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    "if (process.argv.includes('--version')) { console.log('0.0.0-fixture'); process.exit(0); }",
    ...workerBody(report),
    "const { createInterface } = require('node:readline');",
    "const reply = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');",
    "createInterface({ input: process.stdin }).on('line', (line) => {",
    '  const msg = JSON.parse(line);',
    "  if (msg.type === 'get_commands') reply({ type: 'response', id: msg.id, command: msg.type, success: true, data: { commands: [{ name: 'skill:auto' }] } });",
    "  else if (msg.type === 'prompt') { reply({ type: 'response', id: msg.id, command: msg.type, success: true }); reply({ type: 'agent_settled' }); }",
    "  else if (msg.type === 'get_state') reply({ type: 'response', id: msg.id, command: msg.type, success: true, data: { sessionId: 'session-fixture', model: { id: 'gpt-6-astra' }, thinkingLevel: 'high' } });",
    '});',
  ].join('\n'), 'utf8');
  chmodSync(bin, 0o755);
  return {
    adapter: new PiAdapter(bin, dir),
    report,
    input: {
      taskId: 'task-pi', runId: 'run-pi', task: 'Work the ticket.', repoPath: dir,
      evidenceDir: join(dir, 'evidence'), settings: {}, sessionId: 'session-fixture', timeoutMs: 15_000,
    },
  };
}

describe('a local worker cannot reach the coordinator\'s state', () => {
  let box: Sandbox;
  let before: Record<string, string>;
  beforeEach(() => {
    box = sandbox();
    // What the coordinator is holding: an operator and a run, as on a live installation.
    mkdirSync(join(box.root, 'runs'), { recursive: true });
    writeFileSync(join(box.root, 'runs', 'run_live.json'), '{"id":"run_live"}');
    before = digest(box.root);
  });
  afterEach(() => box.cleanup());

  const cases: Array<[string, () => { adapter: { dispatch(i: DispatchInput): Promise<DispatchResult> }; input: DispatchInput; report: string }]> = [
    ['claude-local', claudeCase],
    ['pi-local', piCase],
  ];

  for (const [name, make] of cases) {
    it(`${name}: the worker gets a state directory of its own, outside the coordinator's, and the coordinator's is unchanged`, async () => {
      const { adapter, input, report } = make();
      const result = await adapter.dispatch(input);
      assert.equal(result.outcome.kind, 'completed');

      const worker = readReport(report);
      assert.ok(worker.state, 'the worker is given a state directory, so the CLI never falls back to a default path');
      const given = resolve(worker.state);
      assert.notEqual(given, resolve(box.root));
      assert.ok(!given.startsWith(resolve(box.root) + sep), 'not inside the coordinator\'s state either');
      assert.equal(worker.wrote, true, 'the worker can still write where it was told to');

      assert.deepEqual(digest(box.root), before, 'the coordinator\'s state is byte for byte unchanged');
    });

    it(`${name}: the run's evidence records the state directory its worker was given`, async () => {
      const { adapter, input, report } = make();
      const result = await adapter.dispatch(input);
      const worker = readReport(report);
      const recorded = JSON.parse(readFileSync(join(input.evidenceDir, 'worker-state.json'), 'utf8')) as { agentsysState: string };
      assert.equal(recorded.agentsysState, worker.state);
      assert.equal(result.artifacts?.['workerState'], join(input.evidenceDir, 'worker-state.json'));
    });

    it(`${name}: the worker's state directory is removed when the run ends`, async () => {
      const { adapter, input, report } = make();
      await adapter.dispatch(input);
      assert.equal(existsSync(readReport(report).state!), false);
    });
  }
});
