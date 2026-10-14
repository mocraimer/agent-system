import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { sandbox } from '../core/testkit.js';
import type { Sandbox } from '../core/testkit.js';
import { PiAdapter, PiEvidenceError, PiTeardownError, processGroupAbsent } from './pi.js';

const piScratch: string[] = [];
let box: Sandbox | undefined;
beforeEach(() => { box = sandbox(); });
afterEach(() => {
  box?.cleanup();
  box = undefined;
});
after(() => {
  for (const dir of piScratch) rmSync(dir, { recursive: true, force: true });
});

/** Drive command discovery, prompt acknowledgement and settlement over real RPC pipes. */
function fakePi(
  promptResponse: Record<string, unknown> | undefined,
  events: string[] = [],
  failWrite?: 'stdout' | 'stderr' | 'stderr-after-settled' | 'stderr-on-teardown' | 'final-marker' | 'first-marker',
  teardown?: 'ignore-term' | 'hold-pipes',
  missingSkill = false,
) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-dispatch-'));
  piScratch.push(dir);
  const skillDir = join(dir, 'claude-plugins/manifest-dev/skills/auto');
  const reviewDir = join(dir, 'claude-plugins/manifest-dev-tools/skills/review-pr');
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), 'Protocol fixture', 'utf8');
  writeFileSync(join(reviewDir, 'SKILL.md'), 'Review fixture', 'utf8');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'protocol-fixture', version: '1.0.0' }));
  const bin = join(dir, 'pi');
  const requests = join(dir, 'requests.jsonl');
  const pidFile = join(dir, 'pi.pid');
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    "if (process.argv.includes('--version')) { console.log('0.0.0-fixture'); process.exit(0); }",
    "const { appendFileSync, writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    ...(failWrite === 'stderr-on-teardown' ? [
      "process.on('SIGTERM', () => process.exit(0));",
      "process.on('exit', () => require('node:fs').writeSync(2, 'late teardown warning\\n'));",
    ] : []),
    ...(teardown ? [
      'setInterval(() => {}, 1000);',
      `process.on('SIGTERM', () => { ${teardown === 'ignore-term' ? 'process.stdout.end(); process.stderr.end();' : ''} });`,
    ] : []),
    "const { createInterface } = require('node:readline');",
    "const reply = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');",
    "createInterface({ input: process.stdin }).on('line', (line) => {",
    `  appendFileSync(${JSON.stringify(requests)}, line + '\\n');`,
    '  const msg = JSON.parse(line);',
    "  if (msg.type === 'get_commands') {",
    `    reply({ type: 'response', id: msg.id, command: msg.type, success: true, data: { commands: ${failWrite === 'stderr-on-teardown' || missingSkill ? '[]' : "[{ name: 'skill:auto' }, { name: 'skill:review-pr' }]"} } });`,
    "  } else if (msg.type === 'prompt') {",
    ...(failWrite === 'stderr' ? ["    process.stderr.write('Pi warning before settlement\\n');"] : []),
    ...(promptResponse === undefined ? [] : [
      `    reply({ type: 'response', id: msg.id, command: msg.type, ...${JSON.stringify(promptResponse)} });`,
    ]),
    ...events.map((type) => `    reply({ type: ${JSON.stringify(type)} });`),
    "  } else if (msg.type === 'get_state') {",
    ...(failWrite === 'stderr-after-settled' ? ["    process.stderr.write('late warning after agent_settled\\n');"] : []),
    "    reply({ type: 'response', id: msg.id, command: msg.type, success: true, data: { sessionId: 'session-fixture', model: { id: 'gpt-6-astra' }, thinkingLevel: 'high' } });",
    '  }',
    '});',
  ].join('\n'), 'utf8');
  chmodSync(bin, 0o755);
  return {
    adapter: new PiAdapter(bin, dir, undefined, (path, data, encoding) => {
      if ((failWrite === 'first-marker' && path.endsWith('pi-rpc-events.jsonl') &&
        typeof data === 'string' && JSON.parse(data)['phase'] === 'process-started') ||
        (failWrite === 'stdout' && path.endsWith('pi-rpc-events.jsonl') &&
        typeof data === 'string' && data.includes('"id":"prompt"')) ||
        (failWrite === 'final-marker' && path.endsWith('pi-rpc-events.jsonl') &&
          typeof data === 'string' && JSON.parse(data)['type'] === 'agentsys_local_process_stopped') ||
        (failWrite?.startsWith('stderr') && path.endsWith('pi-stderr.log'))) {
        throw Object.assign(new Error('synthetic evidence write failure'), { code: 'ENOSPC' });
      }
      appendFileSync(path, data, encoding);
    }, teardown ? 150 : 10_000),
    requests,
    pidFile,
    input: {
      taskId: 'task-local', runId: 'run-local', task: 'Exercise prompt protocol',
      repoPath: dir, evidenceDir: join(dir, 'evidence'), settings: {},
      sessionId: 'session-fixture', timeoutMs: 100,
    },
  };
}

function stopFakePiGroup(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* Already stopped. */ }
}

async function waitForGroupAbsent(pid: number | undefined): Promise<void> {
  assert.ok(pid && Number.isSafeInteger(pid));
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw err;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Pi fixture process group ${pid} did not exit`);
}

describe('Pi prompt acknowledgement and settlement', () => {
  it('needs no auto skill to be ready for a prompt entry, and still needs it for a skill entry', async () => {
    const { adapter } = fakePi({ success: true });
    const withoutSkill = new PiAdapter((adapter as unknown as { bin: string }).bin, mkdtempSync(join(tmpdir(), 'pi-noskill-')));
    assert.equal(await withoutSkill.checkReadiness('prompt'), undefined);
    assert.equal((await withoutSkill.checkReadiness('skill'))?.kind, 'setup-blocked');
    assert.equal(await adapter.checkReadiness('review-pr'), undefined);
  });

  it('settles a missing on-disk skill after admission without spawning or sending a prompt', async () => {
    const { adapter, input, requests, pidFile } = fakePi({ success: true });
    rmSync(join(input.repoPath, 'claude-plugins/manifest-dev/skills/auto/SKILL.md'));
    assert.equal((await adapter.checkReadiness('skill'))?.kind, 'setup-blocked');
    const result = await adapter.dispatch(input);
    assert.equal(result.outcome.kind, 'checks-failed');
    assert.equal(result.outcome.promptNotSent, true);
    assert.match(result.outcome.summary, /No task prompt was sent/);
    assert.match(result.outcome.nextAction, /pi install/);
    assert.equal(existsSync(pidFile), false);
    assert.equal(existsSync(requests), false);
  });

  it('sends a prompt entry as written, without the auto wrapper', async () => {
    const { adapter, input, requests } = fakePi({ success: true }, ['agent_settled']);
    const result = await adapter.dispatch({ ...input, entry: 'prompt', task: 'Review pull request #1.' });
    assert.equal(result.outcome.kind, 'completed');
    const prompt = readFileSync(requests, 'utf8').split('\n').find((l) => l.includes('"type":"prompt"'))!;
    assert.equal((JSON.parse(prompt) as { message: string }).message, 'Review pull request #1.');
  });

  it('enters manifest-dev review-pr directly for a review-pr entry', async () => {
    const { adapter, input, requests } = fakePi({ success: true }, ['agent_settled']);
    const result = await adapter.dispatch({ ...input, entry: 'review-pr' });
    assert.equal(result.outcome.kind, 'completed');
    const prompt = readFileSync(requests, 'utf8').split('\n').find((l) => l.includes('"type":"prompt"'))!;
    assert.equal((JSON.parse(prompt) as { message: string }).message, `/skill:review-pr ${input.task}`);
  });

  for (const response of [{}, { success: 'true' }, { success: 'false' }, { success: null }, { success: 0 }]) {
    it(`keeps malformed acknowledgement ${JSON.stringify(response)} uncertain`, async () => {
      const { adapter, input, requests } = fakePi(response);
      const result = await adapter.dispatch(input);
      assert.equal(result.outcome.kind, 'remote-uncertain');
      assert.equal(result.outcome.taskId, input.taskId);
      assert.equal(result.outcome.runId, input.runId);
      assert.match(result.outcome.nextAction, /[Rr]econcile/);
      assert.doesNotMatch(result.outcome.summary, /rejected/);
      assert.match(readFileSync(requests, 'utf8'), /\/skill:auto Exercise prompt protocol/);
      assert.match(readFileSync(join(input.evidenceDir, 'pi-rpc-events.jsonl'), 'utf8'), /"id":"prompt"/);
    });
  }

  it('keeps an absent prompt acknowledgement uncertain after the acknowledgement deadline', { timeout: 40_000 }, async () => {
    // Use the real 30s protocol deadline: fake timers would also affect pipe polling.
    const { adapter, input, requests } = fakePi(undefined);
    const result = await adapter.dispatch(input);
    assert.equal(result.outcome.kind, 'remote-uncertain');
    assert.match(result.outcome.summary, /30s/);
    assert.match(result.outcome.nextAction, /[Rr]econcile/);
    assert.match(readFileSync(requests, 'utf8'), /"type":"prompt"/);
    assert.doesNotMatch(readFileSync(join(input.evidenceDir, 'pi-rpc-events.jsonl'), 'utf8'), /"id":"prompt"/);
  });

  for (const stream of ['stdout', 'stderr'] as const) {
    it(`stops Pi and rejects promptly when ${stream} evidence cannot be appended`, { timeout: 5_000 }, async () => {
      const { adapter, input, requests, pidFile } = fakePi({ success: true }, ['agent_settled'], stream);
      await assert.rejects(adapter.dispatch(input), (error: unknown) => {
        assert.ok(error instanceof PiEvidenceError);
        assert.equal(error.name, 'PiEvidenceError');
        assert.match(error.message, /Could not retain Pi evidence at .*: synthetic evidence write failure/);
        assert.equal(error.localProcessStopped, true);
        assert.equal(error.processId, Number(readFileSync(pidFile, 'utf8')));
        return true;
      });
      assert.match(readFileSync(requests, 'utf8'), /"type":"prompt"/);
      const eventLog = readFileSync(join(input.evidenceDir, 'pi-rpc-events.jsonl'), 'utf8');
      assert.match(eventLog, /"phase":"prompt-sent"/);
      assert.doesNotMatch(eventLog, /"type":"agentsys_local_process_stopped"/);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'Pi was stopped before dispatch rejected');
      assert.equal((await adapter.reconcile('session-fixture', input.evidenceDir)).kind, 'remote-uncertain');
    });
  }

  it('sends no RPC request if the first process-started marker cannot be retained', { timeout: 5_000 }, async () => {
    const { adapter, input, requests, pidFile } = fakePi({ success: true }, ['agent_settled'], 'first-marker');
    await assert.rejects(adapter.dispatch(input), (error: unknown) => {
      assert.ok(error instanceof PiEvidenceError);
      assert.match(error.message, /Could not retain Pi evidence/);
      assert.equal(error.localProcessStopped, true);
      assert.equal(error.sessionId, input.sessionId);
      assert.ok(error.processId, 'spawned process ID remains available despite lost event log');
      assert.equal(processGroupAbsent(error.processId), true, 'the local process group was stopped');
      return true;
    });
    assert.equal(existsSync(requests), false, 'neither command discovery nor a task prompt was sent');
    assert.equal(existsSync(join(input.evidenceDir, 'pi-rpc-events.jsonl')), false);
    if (existsSync(pidFile)) await waitForGroupAbsent(Number(readFileSync(pidFile, 'utf8')));
    const recovered = await adapter.reconcile(input.sessionId, input.evidenceDir);
    assert.equal(recovered.kind, 'remote-uncertain', 'without a retained stop marker no completion can be credited');
    assert.equal(recovered.promptNotSent, undefined, 'an unretained start is not proof for recovery');
  });

  it('does not reconcile a retained settlement as completed after a later stderr write failure', { timeout: 5_000 }, async () => {
    const { adapter, input } = fakePi({ success: true }, ['agent_settled'], 'stderr-after-settled');
    await assert.rejects(adapter.dispatch(input), (error: unknown) => {
      assert.ok(error instanceof PiEvidenceError);
      assert.equal(error.localProcessStopped, true);
      assert.match(error.message, /Could not retain Pi evidence/);
      return true;
    });
    const eventLog = readFileSync(join(input.evidenceDir, 'pi-rpc-events.jsonl'), 'utf8');
    assert.match(eventLog, /"type":"agent_settled"/);
    assert.doesNotMatch(eventLog, /"type":"agentsys_local_process_stopped"/);
    assert.equal((await adapter.reconcile('session-fixture', input.evidenceDir)).kind, 'remote-uncertain');
  });

  it('does not certify settlement when the final local-stop append fails', { timeout: 5_000 }, async () => {
    const { adapter, input, requests, pidFile } = fakePi({ success: true }, ['agent_settled'], 'final-marker');
    await assert.rejects(adapter.dispatch(input), (error: unknown) => {
      assert.ok(error instanceof PiEvidenceError);
      assert.equal(error.localProcessStopped, true);
      assert.equal(error.processId, Number(readFileSync(pidFile, 'utf8')));
      assert.match(error.message, /Could not retain Pi evidence at .*pi-rpc-events\.jsonl/);
      return true;
    });
    const eventLog = readFileSync(join(input.evidenceDir, 'pi-rpc-events.jsonl'), 'utf8');
    assert.match(eventLog, /"type":"agent_settled"/);
    assert.doesNotMatch(eventLog, /"type":"agentsys_local_process_stopped"/);
    assert.match(readFileSync(requests, 'utf8'), /"type":"get_state"/);
    assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
    assert.match(eventLog, /"phase":"streams-closed"/);
    assert.equal((await adapter.reconcile('session-fixture', input.evidenceDir)).kind, 'remote-uncertain',
      'drained pipes and an absent group do not certify escaped descendants stopped');
  });

  it('settles a failed spawn after a successful readiness check without sending a prompt', { timeout: 2_000 }, async () => {
    const { adapter, input } = fakePi({ success: true });
    const check = adapter.checkReadiness.bind(adapter);
    adapter.checkReadiness = async (entry) => {
      const result = await check(entry);
      rmSync((adapter as unknown as { bin: string }).bin);
      return result;
    };
    const result = await adapter.dispatch(input);
    assert.equal(result.outcome.kind, 'checks-failed');
    assert.equal(result.outcome.promptNotSent, true);
    assert.match(result.outcome.summary, /Could not start.*No task prompt was sent/);
  });

  it('settles a missing registered skill only after teardown and evidence drain', async () => {
    const { adapter, input, requests, pidFile } = fakePi({ success: true }, [], undefined, undefined, true);
    const result = await adapter.dispatch(input);
    assert.equal(result.outcome.kind, 'checks-failed');
    assert.equal(result.outcome.promptNotSent, true);
    assert.match(result.outcome.summary, /no task prompt was sent/);
    assert.match(result.outcome.nextAction, /skill commands are enabled/);
    assert.match(readFileSync(requests, 'utf8'), /"type":"get_commands"/);
    assert.doesNotMatch(readFileSync(requests, 'utf8'), /"type":"prompt"/);
    const log = readFileSync(join(input.evidenceDir, 'pi-rpc-events.jsonl'), 'utf8');
    assert.match(log, /"type":"agentsys_local_process_stopped"/);
    assert.doesNotMatch(log, /"phase":"prompt-sent"/);
    const recovered = await adapter.reconcile(input.sessionId, input.evidenceDir);
    assert.equal(recovered.kind, 'checks-failed');
    assert.equal(recovered.promptNotSent, true);
    assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
  });

  it('keeps an early missing-skill return uncertain if the final stop marker cannot be retained', async () => {
    const { adapter, input, requests } = fakePi({ success: true }, [], 'final-marker', undefined, true);
    await assert.rejects(adapter.dispatch(input), (error: unknown) => {
      assert.ok(error instanceof PiEvidenceError);
      assert.equal(error.localProcessStopped, true);
      return true;
    });
    assert.doesNotMatch(readFileSync(requests, 'utf8'), /"type":"prompt"/);
    assert.equal((await adapter.reconcile(input.sessionId, input.evidenceDir)).kind, 'remote-uncertain');
  });

  it('drains queued stderr on an early missing-skill return before settling', { timeout: 5_000 }, async () => {
    const { adapter, input, requests, pidFile } = fakePi({ success: true }, [], 'stderr-on-teardown');
    await assert.rejects(adapter.dispatch(input), /Could not retain Pi evidence/);
    assert.match(readFileSync(requests, 'utf8'), /"type":"get_commands"/);
    assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
  });

  for (const early of ['missing-skill', 'rejected-prompt'] as const) {
    it(`does not report ${early} as settled if the child refuses teardown`, { timeout: 5_000 }, async () => {
      const { adapter, input, pidFile } = fakePi(
        { success: false, error: 'rejected' }, [], undefined, 'ignore-term', early === 'missing-skill',
      );
      let pid: number | undefined;
      try {
        await assert.rejects(adapter.dispatch(input), (error: unknown) => {
          assert.ok(error instanceof PiTeardownError);
          pid = error.processId;
          assert.equal(error.localProcessStopped, false);
          assert.equal(error.sessionId, input.sessionId);
          return true;
        });
        assert.equal(pid, Number(readFileSync(pidFile, 'utf8')));
        const log = readFileSync(join(input.evidenceDir, 'pi-rpc-events.jsonl'), 'utf8');
        assert.doesNotMatch(log, /"type":"agentsys_local_process_stopped"/);
        assert.equal((await adapter.reconcile(input.sessionId, input.evidenceDir)).kind, 'remote-uncertain');
      } finally {
        stopFakePiGroup(pidFile);
      }
    });
  }

  it('reports an explicit boolean rejection as refused', async () => {
    const { adapter, input } = fakePi({ success: false, error: 'Prompt rejected by runtime' });
    const result = await adapter.dispatch(input);
    assert.equal(result.outcome.kind, 'refused');
    assert.match(result.outcome.summary, /Prompt rejected by runtime/);
    assert.match(readFileSync(join(input.evidenceDir, 'pi-rpc-events.jsonl'), 'utf8'), /"success":false/);
  });

  it('reports completion only after agent_settled and retains effective settings', async () => {
    const { adapter, input, requests } = fakePi({ success: true }, ['agent_end', 'agent_settled']);
    const result = await adapter.dispatch(input);
    assert.equal(result.outcome.kind, 'completed');
    assert.equal(result.skill?.continuation, 'completed');
    assert.equal(result.sessionId, 'session-fixture');
    assert.deepEqual(result.settings.observed, { model: 'gpt-6-astra', effort: 'high' });
    assert.match(readFileSync(requests, 'utf8'), /"type":"get_state"/);
    const events = readFileSync(result.artifacts!['eventLog']!, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
      type: string; phase?: string; processId?: number; agentsysReceivedAt?: string;
    });
    assert.ok(events.every((event) => !Number.isNaN(Date.parse(event.agentsysReceivedAt ?? ''))), 'each event has a receipt timestamp');
    const started = events.findIndex((event) => event.phase === 'process-started');
    const sent = events.findIndex((event) => event.phase === 'prompt-sent');
    const settled = events.findIndex((event) => event.type === 'agent_settled');
    const drained = events.findIndex((event) => event.phase === 'streams-closed');
    const stopped = events.findIndex((event) => event.type === 'agentsys_local_process_stopped');
    assert.ok(started >= 0 && started < sent && sent < settled && settled < drained && drained < stopped,
      'phase markers bound startup, provider activity and local teardown');
    assert.ok(Number.isSafeInteger(events[started]!.processId));
    assert.ok(Date.parse(events[started]!.agentsysReceivedAt!) <= Date.parse(events[stopped]!.agentsysReceivedAt!));
    assert.equal((await adapter.reconcile('session-fixture', input.evidenceDir)).kind, 'completed');
  });

  it('treats a locally stopped run without agent_settled as checks-failed', async () => {
    const { adapter, input } = fakePi({ success: true }, ['agent_end']);
    const result = await adapter.dispatch(input);
    assert.equal(result.outcome.kind, 'checks-failed');
    assert.equal(result.skill?.continuation, 'interrupted');
  });

  it('reconciles a settled local run from retained RPC evidence', async () => {
    const { adapter, input } = fakePi({ success: true });
    mkdirSync(input.evidenceDir, { recursive: true });
    writeFileSync(
      join(input.evidenceDir, 'pi-rpc-events.jsonl'),
      `${JSON.stringify({ type: 'agent_settled' })}\n`,
      'utf8',
    );
    const outcome = await adapter.reconcile('session-fixture', input.evidenceDir);
    assert.equal(outcome.kind, 'completed');
  });

  it('does not call a missing prompt acknowledgement completed despite agent_settled', async () => {
    const { adapter, input } = fakePi({ success: 'true' }, ['agent_settled']);
    const result = await adapter.dispatch(input);
    assert.equal(result.outcome.kind, 'remote-uncertain');
    const log = readFileSync(join(input.evidenceDir, 'pi-rpc-events.jsonl'), 'utf8');
    assert.match(log, /"type":"agent_settled"/);
    assert.doesNotMatch(log, /"type":"agentsys_local_process_stopped"/);
    assert.equal((await adapter.reconcile('session-fixture', input.evidenceDir)).kind, 'remote-uncertain');
  });

  it('keeps a stubborn group uncertain until it is explicitly stopped', { timeout: 5_000 }, async () => {
    const { adapter, input, pidFile } = fakePi({ success: true }, ['agent_settled'], undefined, 'ignore-term');
    let pid: number | undefined;
    try {
      await assert.rejects(adapter.dispatch(input), (error: unknown) => {
        assert.ok(error instanceof PiTeardownError);
        assert.equal(error.name, 'PiTeardownError');
        assert.equal(error.localProcessStopped, false);
        assert.equal(error.streamsDrained, true);
        pid = error.processId;
        assert.equal(pid, Number(readFileSync(pidFile, 'utf8')));
        assert.equal(error.sessionId, 'session-fixture');
        return true;
      });
      const log = readFileSync(join(input.evidenceDir, 'pi-rpc-events.jsonl'), 'utf8');
      assert.match(log, /"phase":"streams-closed"/);
      assert.doesNotMatch(log, /"type":"agentsys_local_process_stopped"/);
      assert.equal((await adapter.reconcile('session-fixture', input.evidenceDir)).kind, 'remote-uncertain');
    } finally {
      stopFakePiGroup(pidFile);
    }
    await waitForGroupAbsent(pid);
    const outcome = await adapter.reconcile('session-fixture', input.evidenceDir);
    assert.equal(outcome.kind, 'remote-uncertain');
    assert.match(outcome.nextAction, /resolve-pi/);
  });

  it('does not infer drained evidence when a stubborn process keeps its pipes open', { timeout: 5_000 }, async () => {
    const { adapter, input, pidFile } = fakePi({ success: true }, ['agent_settled'], undefined, 'hold-pipes');
    let pid: number | undefined;
    try {
      await assert.rejects(adapter.dispatch(input), (error: unknown) => {
        assert.ok(error instanceof PiTeardownError);
        assert.equal(error.localProcessStopped, false);
        assert.equal(error.streamsDrained, false);
        pid = error.processId;
        return true;
      });
      assert.equal(pid, Number(readFileSync(pidFile, 'utf8')));
    } finally {
      stopFakePiGroup(pidFile);
    }
    await waitForGroupAbsent(pid);
    const log = readFileSync(join(input.evidenceDir, 'pi-rpc-events.jsonl'), 'utf8');
    assert.doesNotMatch(log, /"phase":"streams-closed"/);
    assert.equal((await adapter.reconcile('session-fixture', input.evidenceDir)).kind, 'remote-uncertain');
  });

  it('never settles markerless new-form evidence regardless of PID and pipe drain', async () => {
    const { adapter, input } = fakePi({ success: true });
    mkdirSync(input.evidenceDir, { recursive: true });
    const logPath = join(input.evidenceDir, 'pi-rpc-events.jsonl');
    for (const processId of [undefined, 0, -1, '123']) {
      for (const drained of [false, true]) {
        writeFileSync(logPath, [
          JSON.stringify({ type: 'agentsys_phase', phase: 'process-started', processId }),
          JSON.stringify({ type: 'agent_settled' }),
          ...(drained ? [JSON.stringify({ type: 'agentsys_phase', phase: 'streams-closed' })] : []),
        ].join('\n') + '\n');
        assert.equal((await adapter.reconcile('session-fixture', input.evidenceDir)).kind, 'remote-uncertain',
          `PID ${String(processId)}, drained ${drained}`);
      }
    }
  });

  it('keeps new-form settled evidence uncertain without a final stop marker', async () => {
    const { adapter, input } = fakePi({ success: true });
    mkdirSync(input.evidenceDir, { recursive: true });
    const logPath = join(input.evidenceDir, 'pi-rpc-events.jsonl');
    for (const phase of ['process-started', 'prompt-sent', 'streams-closed']) {
      writeFileSync(logPath, [
        JSON.stringify({ type: 'agentsys_phase', phase }),
        JSON.stringify({ type: 'agent_settled' }),
      ].join('\n') + '\n', 'utf8');
      assert.equal((await adapter.reconcile('session-fixture', input.evidenceDir)).kind, 'remote-uncertain', phase);
    }
  });

  it('keeps markerless drained evidence uncertain when group is absent and settlement is missing', async () => {
    const { adapter, input } = fakePi({ success: true });
    mkdirSync(input.evidenceDir, { recursive: true });
    const absentPid = 2_000_000_000;
    writeFileSync(join(input.evidenceDir, 'pi-rpc-events.jsonl'), [
      JSON.stringify({ type: 'agentsys_phase', phase: 'process-started', processId: absentPid }),
      JSON.stringify({ type: 'agentsys_phase', phase: 'streams-closed' }),
    ].join('\n') + '\n', 'utf8');
    assert.equal(processGroupAbsent(absentPid), true);
    const outcome = await adapter.reconcile('session-fixture', input.evidenceDir);
    assert.equal(outcome.kind, 'remote-uncertain');
    assert.equal(outcome.details?.['processId'], absentPid);
  });

  it('keeps incomplete local evidence uncertain', async () => {
    const { adapter, input } = fakePi({ success: true });
    mkdirSync(input.evidenceDir, { recursive: true });
    writeFileSync(
      join(input.evidenceDir, 'pi-rpc-events.jsonl'),
      `${JSON.stringify({ type: 'message_end' })}\n`,
      'utf8',
    );
    const outcome = await adapter.reconcile('session-fixture', input.evidenceDir);
    assert.equal(outcome.kind, 'remote-uncertain');
  });

  it('does not treat a state read alone as local teardown', async () => {
    const { adapter, input } = fakePi({ success: true });
    mkdirSync(input.evidenceDir, { recursive: true });
    writeFileSync(
      join(input.evidenceDir, 'pi-rpc-events.jsonl'),
      `${JSON.stringify({ type: 'response', id: 'state', command: 'get_state', success: true, data: { isStreaming: true } })}\n`,
      'utf8',
    );
    const outcome = await adapter.reconcile('session-fixture', input.evidenceDir);
    assert.equal(outcome.kind, 'remote-uncertain');
  });

  it('keeps retained settlement plus final stop without a prompt-sent marker checks-failed', async () => {
    const { adapter, input } = fakePi({ success: true });
    mkdirSync(input.evidenceDir, { recursive: true });
    const log = join(input.evidenceDir, 'pi-rpc-events.jsonl');
    writeFileSync(log, [
      JSON.stringify({ type: 'agentsys_phase', phase: 'process-started' }),
      JSON.stringify({ type: 'agent_settled' }),
      JSON.stringify({ type: 'agentsys_local_process_stopped' }),
    ].join('\n') + '\n');
    const recovered = await adapter.reconcile(input.sessionId, input.evidenceDir);
    assert.equal(recovered.kind, 'checks-failed');
    assert.equal(recovered.promptNotSent, true);
    // Without a retained process start, the missing prompt marker proves nothing.
    writeFileSync(log, [
      JSON.stringify({ type: 'agentsys_phase', phase: 'streams-closed' }),
      JSON.stringify({ type: 'agent_settled' }),
      JSON.stringify({ type: 'agentsys_local_process_stopped' }),
    ].join('\n') + '\n');
    const unknown = await adapter.reconcile(input.sessionId, input.evidenceDir);
    assert.equal(unknown.kind, 'checks-failed');
    assert.equal(unknown.promptNotSent, undefined);
    writeFileSync(log, [
      JSON.stringify({ type: 'agent_settled' }),
      JSON.stringify({ type: 'agentsys_local_process_stopped' }),
    ].join('\n') + '\n');
    const noStart = await adapter.reconcile(input.sessionId, input.evidenceDir);
    assert.equal(noStart.kind, 'checks-failed', 'a final stop marker rules out legacy markerless completion');
    assert.equal(noStart.promptNotSent, undefined);
  });

  it('reconciles a confirmed local teardown without settlement as checks-failed', async () => {
    const { adapter, input } = fakePi({ success: true });
    mkdirSync(input.evidenceDir, { recursive: true });
    writeFileSync(
      join(input.evidenceDir, 'pi-rpc-events.jsonl'),
      [
        JSON.stringify({ type: 'response', id: 'state', command: 'get_state', success: false }),
        JSON.stringify({ type: 'agentsys_local_process_stopped' }),
      ].join('\n') + '\n',
      'utf8',
    );
    const outcome = await adapter.reconcile('session-fixture', input.evidenceDir);
    assert.equal(outcome.kind, 'checks-failed');
  });
});

describe('process group absence probe', () => {
  it('uses a negative group ID and returns true only on ESRCH', () => {
    const seen: Array<[number, number]> = [];
    const absent = (pid: number, signal: 0): void => {
      seen.push([pid, signal]);
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    };
    assert.equal(processGroupAbsent(4321, absent), true);
    assert.deepEqual(seen, [[-4321, 0]]);
  });

  it('treats a live group and EPERM as not absent', () => {
    assert.equal(processGroupAbsent(4321, () => {}), false);
    assert.equal(processGroupAbsent(4321, () => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    }), false);
  });

  it('never probes invalid group IDs', () => {
    for (const pid of [undefined, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(processGroupAbsent(pid, () => { assert.fail('invalid PID probed'); }), false);
    }
  });
});

describe('pi reports its subscription usage without inventing a cause', () => {
  const reading = {
    subscriptionId: 'openai-codex', observedAt: new Date().toISOString(),
    source: 'codex app-server account/rateLimits/read', windows: [],
  };

  it('passes a real reading straight through, contents included', async () => {
    const pi = new PiAdapter('pi', '/nonexistent', {
      readUsage: () => Promise.resolve({ ok: true as const, reading }),
    });
    const result = await pi.readUsage();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Asserting only `ok` would pass against an implementation that rebuilt the
    // reading instead of returning it, and the rebuilt one is what callers would
    // then admit work against. Every field a caller uses is checked.
    assert.equal(result.reading.subscriptionId, 'openai-codex');
    assert.equal(result.reading.source, 'codex app-server account/rateLimits/read');
    assert.equal(result.reading.observedAt, reading.observedAt);
    assert.deepEqual(result.reading.windows, reading.windows);
    assert.deepEqual(result.reading, reading, 'the reading arrives unmodified');
  });

  it('passes the reading’s windows through rather than emptying them', async () => {
    // A reading with no windows cannot admit anything, so an implementation that
    // dropped them would look like a quota block rather than a bug.
    const withWindows = {
      ...reading,
      windows: [{ kind: 'five-hour' as const, usedPercent: 12, resetsAt: reading.observedAt, vendorLabel: 'primary' }],
    };
    const pi = new PiAdapter('pi', '/nonexistent', {
      readUsage: () => Promise.resolve({ ok: true as const, reading: withWindows }),
    });
    const result = await pi.readUsage();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.reading.windows.length, 1);
    assert.equal(result.reading.windows[0]?.usedPercent, 12);
  });

  it('reports the reader\'s own reason rather than asserting one of its own', async () => {
    // The failure that motivated this: the app-server starts fine and the vendor
    // rejects the refresh token. A hardcoded "server is not reachable" named the
    // wrong cause and would have sent an operator to fix a working component.
    const pi = new PiAdapter('pi', '/nonexistent', {
      readUsage: () => Promise.resolve({
        ok: false as const,
        unavailable: {
          subscriptionId: 'openai-codex', attemptedAt: new Date().toISOString(),
          source: 'codex app-server account/rateLimits/read (process-local sqlite_home)',
          reason: 'Failed to refresh token: 401 Unauthorized',
          operatorAction: 'Run `codex login`. The same credential failure blocks Codex cloud, so one sign-in clears both.',
        },
      }),
    });
    const result = await pi.readUsage();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.unavailable.reason, /401 Unauthorized/);
    assert.match(result.unavailable.operatorAction, /codex login/);
    assert.doesNotMatch(result.unavailable.reason, /not reachable/);
    assert.match(result.unavailable.source, /^pi \(no usage interface\); read through /);
    assert.equal(result.unavailable.subscriptionId, 'openai-codex');
  });
});

describe('the tier an approval bound the run to', () => {
  it('becomes the resolved setting and reaches the command line', async () => {
    const { adapter, input } = fakePi({ success: true }, ['agent_settled']);
    const result = await adapter.dispatch({
      ...input,
      approvedTier: { model: 'gpt-5.6-luna', effort: 'max' },
    });

    assert.deepEqual(result.settings.resolved, { model: 'gpt-5.6-luna', effort: 'max' });
    assert.match(result.skill!.invocation, /--model gpt-5\.6-luna/);
    assert.match(result.skill!.invocation, /--thinking max/);
  });

  it('is outranked by what the caller named, and the record keeps them apart', async () => {
    const { adapter, input } = fakePi({ success: true }, ['agent_settled']);
    const result = await adapter.dispatch({
      ...input,
      settings: { model: 'gpt-6-astra' },
      approvedTier: { model: 'gpt-5.6-luna', effort: 'max' },
    });

    assert.equal(result.settings.requested.model, 'gpt-6-astra');
    assert.deepEqual(result.settings.resolved, { model: 'gpt-6-astra', effort: 'max' });
    assert.match(result.skill!.invocation, /--model gpt-6-astra/);
  });

  it('leaves the adapter\'s own default in place when no tier was approved', async () => {
    const { adapter, input } = fakePi({ success: true }, ['agent_settled']);
    const result = await adapter.dispatch(input);

    assert.deepEqual(result.settings.resolved, { model: 'gpt-6-astra', effort: 'high' });
  });
});
