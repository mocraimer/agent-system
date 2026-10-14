import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { OPERATOR, sandbox } from '../core/testkit.js';
import { createCoordinatorCommands } from '../commands.js';
import { ClaudeWebAdapter } from './claude-web.js';
import type { Sandbox } from '../core/testkit.js';
import type { UsageResult } from '../core/usage.js';
import { ClaudeLocalAdapter } from './claude-local.js';
import type { DispatchInput } from './types.js';
import { UnsupportedSettingError } from './types.js';

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const noUsage: { readUsage(): Promise<UsageResult> } = {
  readUsage: () => Promise.resolve({
    ok: false,
    unavailable: { subscriptionId: 'claude-max', attemptedAt: 'now', source: 'fixture', reason: 'fixture', operatorAction: 'none' },
  }),
};

/**
 * A stand-in `claude` that answers `auth status` and, for `-p`, prints what the
 * fixture says and exits with the fixture's code. It records its argv so a test
 * can see what the adapter actually asked for.
 */
function fakeClaude(behaviour: { stdout?: string; stderr?: string; code?: number; sleepMs?: number; loggedIn?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-local-'));
  scratch.push(dir);
  const bin = join(dir, 'claude');
  const argvLog = join(dir, 'argv.json');
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    "const { writeFileSync } = require('node:fs');",
    'const args = process.argv.slice(2);',
    "if (args[0] === 'auth') {",
    `  process.stdout.write(JSON.stringify({ loggedIn: ${behaviour.loggedIn ?? true} }));`,
    '  process.exit(0);',
    '}',
    `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args));`,
    `const done = () => { process.stdout.write(${JSON.stringify(behaviour.stdout ?? '')}); process.stderr.write(${JSON.stringify(behaviour.stderr ?? '')}); process.exit(${behaviour.code ?? 0}); };`,
    `setTimeout(done, ${behaviour.sleepMs ?? 0});`,
  ].join('\n'), 'utf8');
  chmodSync(bin, 0o755);
  const input: DispatchInput = {
    taskId: 'local-probe', runId: 'run-local', task: 'Read the README and say what it is.',
    repoPath: dir, evidenceDir: join(dir, 'evidence'), settings: { model: 'claude-opus-5', effort: 'medium' },
    entry: 'prompt', actions: ['review'],
  };
  return { bin, adapter: new ClaudeLocalAdapter(bin, noUsage), input, argv: () => JSON.parse(readFileSync(argvLog, 'utf8')) as string[], argvLog };
}

const success = JSON.stringify({
  type: 'result', is_error: false, result: 'It is a README.', session_id: 's',
  modelUsage: { 'claude-opus-5': { costUSD: 0.1 } },
});

describe('claude-local dispatch', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.cleanup());

  it('runs the prompt at the requested tier and keeps stdout and stderr in the evidence directory', async () => {
    const { adapter, input, argv } = fakeClaude({ stdout: success, stderr: 'a warning' });
    const result = await adapter.dispatch(input);
    assert.equal(result.outcome.kind, 'completed');
    const args = argv();
    assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5');
    assert.equal(args[args.indexOf('--effort') + 1], 'medium');
    assert.equal(args[args.indexOf('-p') + 1], input.task, 'a prompt entry is sent as written');
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'Bash,Read,Glob,Grep,WebFetch,Skill', 'a review run gets no write tools');
    assert.deepEqual(result.settings.requested, { model: 'claude-opus-5', effort: 'medium' });
    assert.deepEqual(result.settings.resolved, { model: 'claude-opus-5', effort: 'medium' });
    assert.deepEqual(result.settings.observed, { model: 'claude-opus-5', effort: 'unknown' });
    assert.deepEqual(readdirSync(input.evidenceDir).sort(),
      ['claude-local-prompt.txt', 'claude-local-stderr.log', 'claude-local-stdout.json']);
    assert.equal(readFileSync(join(input.evidenceDir, 'claude-local-stderr.log'), 'utf8'), 'a warning');
    assert.ok(result.sessionId, 'the session id is recorded');
    assert.equal(args[args.indexOf('--session-id') + 1], result.sessionId);
  });

  it('pins a future default to Opus 5.5 with the existing explicit medium effort', async () => {
    const { adapter, input, argv } = fakeClaude({ stdout: JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'Done.', stop_reason: 'end_turn',
      modelUsage: { 'claude-haiku-4-5': {}, 'claude-opus-5-5': {} },
    }) });
    const result = await adapter.dispatch({ ...input, settings: {} });
    const args = argv();
    assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5');
    assert.equal(args[args.indexOf('--effort') + 1], 'medium');
    assert.equal(args.includes('--fallback-model'), false);
    assert.deepEqual(result.settings.requested, { model: 'vendor-default', effort: 'vendor-default' });
    assert.deepEqual(result.settings.resolved, { model: 'claude-opus-5-5', effort: 'medium' });
    assert.deepEqual(result.settings.observed, { model: 'claude-opus-5-5', effort: 'unknown' });
    assert.equal(result.outcome.kind, 'completed');
  });

  for (const model of ['claude-opus-5', 'opus', 'claude-fable-5-1']) {
    it(`preserves an explicit approval for ${model}`, async () => {
      const { adapter, input, argv } = fakeClaude({ stdout: success });
      const result = await adapter.dispatch({ ...input, settings: {}, approvedTier: { model, effort: 'high' } });
      assert.deepEqual(result.settings.resolved, { model, effort: 'high' });
      assert.equal(argv()[argv().indexOf('--model') + 1], model);
      assert.equal(argv()[argv().indexOf('--effort') + 1], 'high');
    });
  }

  for (const [label, response, code] of [
    ['refusal despite a success envelope', { subtype: 'success', is_error: false, result: 'Cannot help.', stop_reason: 'refusal' }, 0],
    ['unsupported model', { subtype: 'error_during_execution', is_error: true, errors: ['Model claude-opus-5-5 is unavailable.'] }, 1],
    ['execution error with partial text', { subtype: 'error_during_execution', is_error: true, result: 'Partial work.' }, 0],
  ] as const) {
    it(`does not complete new-model ${label}`, async () => {
      const { adapter, input, argv } = fakeClaude({ stdout: JSON.stringify(response), code });
      const result = await adapter.dispatch({ ...input, settings: { model: 'claude-opus-5-5', effort: 'medium' } });
      assert.equal(result.outcome.kind, 'checks-failed');
      assert.equal(result.settings.observed.model, 'unknown');
      assert.equal(argv()[argv().indexOf('--model') + 1], 'claude-opus-5-5');
      assert.equal(result.skill?.continuation, 'interrupted');
      assert.match(result.outcome.nextAction, /retained stdout and stderr/);
      assert.equal((await adapter.reconcile(result.sessionId!, input.evidenceDir)).kind, 'checks-failed');
    });
  }

  for (const [label, modelUsage, observed] of [
    ['only an auxiliary model', { 'claude-haiku-4-5': {} }, 'claude-haiku-4-5'],
    ['a substituted older model', { 'claude-opus-5': {} }, 'claude-opus-5'],
    ['ambiguous auxiliary and substitute', { 'claude-haiku-4-5': {}, 'claude-sonnet-5': {} }, 'unknown'],
    ['a pricing alias, not an execution ID', { 'claude-haiku-4-5': {}, 'provider-alias': { canonicalModel: 'claude-opus-5-5' } }, 'unknown'],
    ['no usage', {}, 'unknown'],
  ] as const) {
    it(`does not claim confirmed 5.5 from ${label}`, async () => {
      const { adapter, input } = fakeClaude({ stdout: JSON.stringify({ is_error: false, result: 'Done.', modelUsage }) });
      const result = await adapter.dispatch({ ...input, settings: { model: 'claude-opus-5-5', effort: 'medium' } });
      assert.equal(result.settings.observed.model, observed);
      assert.equal(result.settings.observed.effort, 'unknown');
      if (observed !== 'unknown') assert.match(result.settings.substitution ?? '', /where "claude-opus-5-5" was resolved/);
    });
  }

  it('wraps a skill entry in the manifest-dev entry and gives an authoring run write tools', async () => {
    const { adapter, input, argv } = fakeClaude({ stdout: success });
    await adapter.dispatch({ ...input, entry: 'skill', actions: ['author-changes', 'push-branch'] });
    const args = argv();
    assert.equal(args[args.indexOf('-p') + 1], `/manifest-dev:auto ${input.task}`);
    assert.match(args[args.indexOf('--allowedTools') + 1]!, /Write,Edit/);
  });

  it('enters manifest-dev review-pr directly for a review entry', async () => {
    const { adapter, input, argv } = fakeClaude({ stdout: success });
    await adapter.dispatch({ ...input, entry: 'review-pr' });
    const args = argv();
    assert.equal(args[args.indexOf('-p') + 1], `/manifest-dev-tools:review-pr ${input.task}`);
  });

  it('uses the approved tier when the caller names none', async () => {
    const { adapter, input, argv } = fakeClaude({ stdout: success });
    await adapter.dispatch({ ...input, settings: {}, approvedTier: { model: 'claude-fable-5-1', effort: 'high' } });
    const args = argv();
    assert.equal(args[args.indexOf('--model') + 1], 'claude-fable-5-1');
    assert.equal(args[args.indexOf('--effort') + 1], 'high');
  });

  it('refuses an effort the runtime does not declare, before anything is spawned', async () => {
    const { adapter, input, argvLog } = fakeClaude({ stdout: success });
    await assert.rejects(adapter.dispatch({ ...input, settings: { effort: 'minimal' } }), UnsupportedSettingError);
    assert.equal(existsSync(argvLog), false, 'the binary was never run with -p');
  });

  it('reports a missing binary as a setup gap naming it', async () => {
    const missing = join(tmpdir(), 'no-such-dir', 'claude-not-installed');
    const adapter = new ClaudeLocalAdapter(missing, noUsage);
    const { input } = fakeClaude({});
    const result = await adapter.dispatch(input);
    assert.equal(result.outcome.kind, 'setup-blocked');
    assert.match(result.outcome.summary, /claude-not-installed/);
    const ready = await adapter.checkReadiness();
    assert.equal(ready?.kind, 'setup-blocked');
    assert.match(ready!.summary, /not found on PATH/);
  });

  it('reports a signed-out CLI as a setup gap', async () => {
    const { adapter } = fakeClaude({ loggedIn: false });
    const ready = await adapter.checkReadiness();
    assert.equal(ready?.kind, 'setup-blocked');
    assert.match(ready!.summary, /no signed-in account/);
  });

  for (const [label, behaviour] of [
    ['a usage-limit message', { stdout: JSON.stringify({ is_error: true, result: 'Claude AI usage limit reached|1789999999' }), code: 1 }],
    ['an HTTP 429 status', { stdout: JSON.stringify({ is_error: true, result: 'error', api_error_status: 429 }), code: 1 }],
    ['a rate-limit line on stderr', { stdout: '', stderr: 'API Error: Rate limit exceeded', code: 1 }],
  ] as const) {
    it(`tells a rate limit apart from a task failure: ${label}`, async () => {
      const { adapter, input } = fakeClaude(behaviour);
      const result = await adapter.dispatch(input);
      assert.equal(result.outcome.kind, 'quota-waiting');
    });
  }

  it('reports a failed task as a failure, not a rate limit', async () => {
    const { adapter, input } = fakeClaude({ stdout: JSON.stringify({ is_error: true, result: 'The tests did not pass.' }), code: 1 });
    const result = await adapter.dispatch(input);
    assert.equal(result.outcome.kind, 'checks-failed');
  });

  it('does not read a finished run that mentions 429 as a rate limit', async () => {
    const { adapter, input } = fakeClaude({ stdout: JSON.stringify({ is_error: false, result: 'The handler now retries on HTTP 429.' }) });
    const result = await adapter.dispatch(input);
    assert.equal(result.outcome.kind, 'completed');
  });

  it('stops a run that outlives its timeout and says so', async () => {
    const { adapter, input } = fakeClaude({ stdout: success, sleepMs: 30_000 });
    const result = await adapter.dispatch({ ...input, timeoutMs: 300 });
    assert.equal(result.outcome.kind, 'checks-failed');
    assert.match(result.outcome.summary, /did not finish within/);
    assert.equal(result.skill?.continuation, 'interrupted');
  });

  it('reads the resolved model back when the run also billed a housekeeping model', async () => {
    // The shape a real run at claude-opus-5 · medium returned on 2026-09-18.
    const both = JSON.stringify({ is_error: false, result: 'ok', modelUsage: {
      'claude-haiku-4-5-20251001': { canonicalModel: 'claude-haiku-4-5' }, 'claude-opus-5': { canonicalModel: 'claude-opus-5' },
    } });
    const { adapter, input } = fakeClaude({ stdout: both });
    const result = await adapter.dispatch(input);
    assert.equal(result.settings.observed.model, 'claude-opus-5');
    assert.equal(result.settings.substitution, undefined);
  });

  it('reports a substitution when the only model billed is not the one resolved', async () => {
    const other = JSON.stringify({ is_error: false, result: 'ok', modelUsage: { 'claude-sonnet-5': {} } });
    const { adapter, input } = fakeClaude({ stdout: other });
    const result = await adapter.dispatch(input);
    assert.equal(result.settings.observed.model, 'claude-sonnet-5');
    assert.match(result.settings.substitution ?? '', /claude-sonnet-5/);
  });

  it('does not guess when several models billed and none is the resolved one', async () => {
    const two = JSON.stringify({ is_error: false, result: 'ok', modelUsage: { 'claude-sonnet-5': {}, 'claude-haiku-4-5': {} } });
    const { adapter, input } = fakeClaude({ stdout: two });
    const result = await adapter.dispatch(input);
    assert.equal(result.settings.observed.model, 'unknown');
  });
});

describe('Claude migration through coordinator commands', () => {
  for (const runtime of ['claude-local', 'claude-web'] as const) {
    for (const mode of ['future default', 'old approval', 'contradicting request'] as const) {
      it(`${runtime}: ${mode} respects approval before the actual subprocess`, async () => {
        const box = sandbox();
        try {
          const fixture = fakeClaude({ stdout: runtime === 'claude-web'
            ? JSON.stringify({ ok: true, session_id: 'cloud-test' })
            : JSON.stringify({ is_error: false, result: 'Done.', modelUsage: { [mode === 'future default' ? 'claude-opus-5-5' : 'claude-opus-5']: {} } }),
          });
          const adapter = runtime === 'claude-local' ? fixture.adapter : new ClaudeWebAdapter(fixture.bin, 'cloud-test');
          adapter.readUsage = () => Promise.resolve({ ok: true, reading: {
            subscriptionId: 'claude-max', observedAt: new Date().toISOString(), source: 'isolated usage fixture',
            windows: [{ kind: 'five-hour', usedPercent: 1, vendorLabel: 'session' }, { kind: 'weekly', usedPercent: 1, vendorLabel: 'week' }],
          } });
          const commands = createCoordinatorCommands(() => adapter);
          const approval = commands.approve(OPERATOR, {
            repo: 'example/model-test', taskScope: 'Read the README.', workClass: 'ci-repair',
            runtime, profile: 'default', actions: ['review'],
            limits: { maxAttempts: 1, maxConcurrentRuns: 1, maxPaidCallUsd: 0 },
            ...(mode === 'future default' ? {} : { model: 'claude-opus-5', effort: 'high' }),
          });
          const result = await commands.dispatch({
            taskId: 'model-command-test', repo: 'example/model-test', workClass: 'ci-repair', runtime,
            profile: 'default', actions: ['review'], approvalId: approval.id, prompt: 'Read the README.',
            repoPath: fixture.input.repoPath, entry: 'prompt',
            settings: mode === 'contradicting request' ? { model: 'claude-opus-5-5', effort: 'high' } : {},
            estimate: { fiveHourPercent: 1, weeklyPercent: 1, basis: 'operator-bound', uncertaintyPercent: 1, detail: 'fixture' },
          });
          if (mode === 'contradicting request') {
            assert.equal(result.outcome.kind, 'refused');
            assert.equal(result.runtimeDispatched, false);
            assert.equal(existsSync(fixture.argvLog), false);
          } else {
            const model = mode === 'future default' ? 'claude-opus-5-5' : 'claude-opus-5';
            const effort = mode === 'old approval' || runtime === 'claude-web' ? 'high' : 'medium';
            assert.equal(result.runtimeDispatched, true);
            assert.equal(result.outcome.kind, runtime === 'claude-web' ? 'remote-uncertain' : 'completed');
            assert.deepEqual(result.run?.settings.resolved, { model, effort });
            assert.equal(result.run?.settings.observed.model, runtime === 'claude-web' ? 'unknown' : model);
            const args = fixture.argv();
            assert.equal(args[args.indexOf('--model') + 1], model);
            assert.equal(args[args.indexOf('--effort') + 1], effort);
          }
        } finally { box.cleanup(); }
      });
    }
  }
});

describe('claude-local recovery', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.cleanup());

  it('settles a session whose process is gone, reading its result from disk', async () => {
    const { adapter, input } = fakeClaude({});
    const dir = join(box.root, 'claude-local');
    const evidence = join(input.repoPath, 'lost-run');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'claude-local-stdout.json'), success);
    // A pid that cannot be running: the kernel never hands out 2^22 + 1.
    writeFileSync(join(dir, 'lost.json'), JSON.stringify({ pid: 4_194_305, evidenceDir: evidence }));
    const outcome = await adapter.reconcile('lost');
    assert.equal(outcome.kind, 'completed');
    assert.equal(existsSync(join(dir, 'lost.json')), false);
  });

  it('uses the run evidence directory after its PID marker is gone', async () => {
    const { adapter, input } = fakeClaude({});
    const evidence = join(input.repoPath, 'finished-run');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'claude-local-stdout.json'), success);
    const outcome = await adapter.reconcile('finished', evidence);
    assert.equal(outcome.kind, 'completed');
  });

  it('does not treat incomplete stdout as a successful local result', async () => {
    const { adapter, input } = fakeClaude({});
    const evidence = join(input.repoPath, 'incomplete-run');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'claude-local-stdout.json'), '{}');
    const outcome = await adapter.reconcile('incomplete', evidence);
    assert.equal(outcome.kind, 'checks-failed');
  });

  it('keeps a session whose process is alive uncertain', async () => {
    const { adapter } = fakeClaude({});
    const dir = join(box.root, 'claude-local');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'live.json'), JSON.stringify({ pid: process.pid }));
    const outcome = await adapter.reconcile('live');
    assert.equal(outcome.kind, 'remote-uncertain');
    assert.match(outcome.summary, /still running/);
  });

  it('settles a session nobody recorded as failed, so it cannot block forever', async () => {
    const { adapter } = fakeClaude({});
    const outcome = await adapter.reconcile('never-seen');
    assert.equal(outcome.kind, 'checks-failed');
  });
});
