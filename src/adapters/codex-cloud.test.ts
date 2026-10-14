import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { CODEX_CLOUD_CAPABILITIES, CodexCloudAdapter, toReading, summarise } from './codex-cloud.js';
import { PI_DEFAULT_SUBSCRIPTION } from './pi.js';
import { resolveSettings, UnsupportedSettingError } from './types.js';

describe('Codex cloud capabilities match what the CLI actually accepts', () => {
  it('declares no model or effort control', () => {
    // `codex cloud exec --help` on codex-cli 0.143.0 offers only --env, --branch
    // and --attempts. Declaring control the runtime lacks is what would let an
    // unsupported request be silently dropped.
    assert.equal(CODEX_CLOUD_CAPABILITIES.supportsModelSelection, false);
    assert.equal(CODEX_CLOUD_CAPABILITIES.supportsEffortSelection, false);
    assert.deepEqual(CODEX_CLOUD_CAPABILITIES.effortLevels, []);
  });

  it('declares that it reports no effective settings', () => {
    assert.equal(CODEX_CLOUD_CAPABILITIES.reportsEffectiveSettings, false);
  });

  it('shares one admission state with local Pi by default', () => {
    // Whether these are literally one ChatGPT account is unverified; sharing is the
    // conservative default, and both ids are overridable once identity is established.
    assert.equal(CODEX_CLOUD_CAPABILITIES.subscriptionId, PI_DEFAULT_SUBSCRIPTION);
  });

  it('rejects a specific model request rather than running vendor-default instead', () => {
    assert.throws(
      () => resolveSettings(CODEX_CLOUD_CAPABILITIES, { model: 'gpt-5.5', acceptVendorDefault: true }),
      UnsupportedSettingError,
    );
  });
});

describe('Codex cloud readiness fails closed', () => {
  it('blocks with no environment id', async () => {
    const outcome = await new CodexCloudAdapter({}).checkReadiness();
    assert.equal(outcome?.kind, 'setup-blocked');
    assert.match(outcome?.summary ?? '', /requires `--env`/);
  });

  it('blocks until skill entry has actually been observed', async () => {
    // A configured environment and working credentials are not enough: a cloud run
    // that merely receives the words "/auto" has not entered the skill.
    const adapter = new CodexCloudAdapter({ envId: 'env_x' }, '/bin/true');
    const outcome = await adapter.checkReadiness();
    assert.equal(outcome?.kind, 'setup-blocked');
    assert.match(outcome?.summary ?? '', /not confirmed to load the manifest-dev skill/);
  });

  it('does not send the operator down the setup-script route, which cannot work', async () => {
    // Tried on 2026-09-10: the cloud setup script runs in a build container with no
    // `codex` binary and died with "codex: command not found", exit 127. The message
    // used to recommend exactly that, so it cost an operator a real cloud run to learn
    // it was impossible.
    const adapter = new CodexCloudAdapter({ envId: 'env_x' }, '/bin/true');
    const outcome = await adapter.checkReadiness();
    assert.match(outcome?.nextAction ?? '', /Do not try to install it from the environment setup script/);
    assert.match(outcome?.nextAction ?? '', /command not found/);
  });

  it('reports a 401 as a credential problem with the command that fixes it', async () => {
    const adapter = new CodexCloudAdapter({ envId: 'env_x' }, '/bin/false');
    const outcome = await adapter.checkReadiness();
    assert.equal(outcome?.kind, 'setup-blocked');
    assert.match(outcome?.nextAction ?? '', /codex login/);
  });

  it('classifies windows by reported duration, not by primary/secondary position', () => {
    // The schema makes both fields nullable and says nothing about which window is
    // which, so position is not evidence. A weekly window reported as `primary`
    // must still be classified weekly.
    const reading = toReading('openai-codex', '2026-09-09T00:00:00Z', {
      primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1788000000 },
      secondary: { usedPercent: 34, windowDurationMins: 300 },
    });
    const weekly = reading.windows.find((w) => w.kind === 'weekly');
    const fiveHour = reading.windows.find((w) => w.kind === 'five-hour');
    assert.equal(weekly?.usedPercent, 12, 'the weekly window was reported as primary');
    assert.equal(weekly?.vendorLabel, 'primary');
    assert.equal(fiveHour?.usedPercent, 34);
    assert.ok(weekly?.resetsAt?.startsWith('20'), 'epoch seconds become an ISO instant');
  });

  it('reports no windows rather than guessing when the snapshot is empty', () => {
    assert.deepEqual(toReading('openai-codex', '2026-09-09T00:00:00Z', {}).windows, []);
    assert.deepEqual(toReading('openai-codex', '2026-09-09T00:00:00Z', null).windows, []);
  });

  it('never reports usage as available, whatever the reason', async () => {
    // Whichever branch is taken, the one thing that must never happen is a reading
    // that admission could spend. The two branches differ in their advice, so the
    // invariant is asserted here and the wording below.
    for (const bin of ['/bin/true', '/nonexistent-codex-binary']) {
      const result = await new CodexCloudAdapter({ envId: 'env_x' }, bin).readUsage();
      assert.equal(result.ok, false, `${bin} must not yield a usable reading`);
      assert.ok(
        (result.ok === false ? result.unavailable.operatorAction : '').length > 0,
        'an unavailable reading must still name an operator action',
      );
    }
  });

  it('reports a missing binary as a launch problem, not a credential one', async () => {
    const missing = await new CodexCloudAdapter({ envId: 'env_x' }, '/nonexistent-codex-binary').readUsage();
    assert.equal(missing.ok, false);
    assert.doesNotMatch(
      missing.ok === false ? missing.unavailable.operatorAction : '',
      /codex login/,
      'a missing binary is not fixed by signing in',
    );
  });

  it('names the sqlite_home option in its source, so the read is reproducible', async () => {
    const r = await new CodexCloudAdapter({ envId: 'env_x' }, '/bin/true').readUsage();
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.unavailable.source : '', /sqlite_home/);
  });
});

describe('a vendor error reaches the operator as something they can act on', () => {
  it('lifts the message out of an embedded response body', () => {
    // The real failure: the useful sentence arrived under eight lines of JSON.
    const raw = '-32603 failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage'
      + ' failed: 401 Unauthorized; content-type=text/plain; body={\n  "error": {\n'
      + '    "message": "Could not parse your authentication token. Please try signing in again.",\n'
      + '    "type": null,\n    "code": "unauthorized_unknown",\n    "param": null\n  },\n  "status": 401\n}';
    const out = summarise(raw);
    assert.match(out, /Could not parse your authentication token/);
    assert.doesNotMatch(out, /\n/, 'an operator line is one line');
    assert.doesNotMatch(out, /"status"/, 'the raw body does not survive');
    assert.match(out, /401 Unauthorized/, 'the context before the body is kept');
  });

  it('keeps text that is not a response body', () => {
    assert.equal(summarise('app-server did not answer in time'), 'app-server did not answer in time');
  });

  it('collapses whitespace and caps runaway text', () => {
    assert.equal(summarise('two   lines\n  here'), 'two lines here');
    const long = summarise('x'.repeat(500));
    assert.ok(long.length <= 300, `capped, got ${long.length}`);
    assert.ok(long.endsWith('…'), 'a truncated line says it was truncated');
    assert.equal(summarise('x'.repeat(300)).length, 300, 'text at the cap is not truncated');
  });

  it('falls back to the flat text when the body is not JSON', () => {
    const out = summarise('failed: body={not json at all');
    assert.match(out, /not json at all/);
  });
});


describe('reading the rate-limits answer the server actually sends', () => {
  /**
   * Verbatim `account/rateLimits/read` result from codex-cli on 2026-09-09, kept
   * whole so the nesting is tested against the vendor's real shape rather than a
   * hand-written echo of it. Note `secondary: null`: this plan reports one window.
   */
  const REAL_RESULT = {
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 36, windowDurationMins: 10080, resetsAt: 1789437611 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      individualLimit: null,
      planType: 'prolite',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        primary: { usedPercent: 36, windowDurationMins: 10080, resetsAt: 1789437611 },
        secondary: null,
      },
    },
  };

  it('finds the windows nested under rateLimits, not on the result itself', () => {
    // Reading the outer object found no `primary` at all and produced a reading
    // that reported ok with nothing in it.
    const reading = toReading('openai-codex', '2026-09-09T18:10:00.000Z', REAL_RESULT);
    assert.equal(reading.windows.length, 1);
    assert.equal(reading.windows[0]?.usedPercent, 36);
  });

  it('classifies a 10080-minute window as weekly, whatever the vendor called it', () => {
    const reading = toReading('openai-codex', '2026-09-09T18:10:00.000Z', REAL_RESULT);
    assert.equal(reading.windows[0]?.kind, 'weekly');
    assert.equal(reading.windows[0]?.vendorLabel, 'primary');
  });

  it('still reads a snapshot handed over already unwrapped', () => {
    const reading = toReading('openai-codex', '2026-09-09T18:10:00.000Z', REAL_RESULT.rateLimits);
    assert.equal(reading.windows.length, 1);
    assert.equal(reading.windows[0]?.usedPercent, 36);
  });

  it('reports no window for a null one rather than inventing a zero', () => {
    // `secondary` is null here. A window read as 0% used would be an allowance
    // claim nobody made, and the most permissive one available.
    const reading = toReading('openai-codex', '2026-09-09T18:10:00.000Z', REAL_RESULT);
    assert.equal(reading.windows.find((w) => w.kind === 'five-hour'), undefined);
  });
});


const codexScratch: string[] = [];
after(() => {
  for (const dir of codexScratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in `codex app-server` that speaks just enough of the protocol: it
 * answers `initialize`, then answers `account/rateLimits/read` with the given
 * result. Driving the real spawn-and-parse path is the point — a unit test of
 * `toReading` alone would not have caught a `readUsage` that reports a windowless
 * answer as a healthy reading.
 */
function fakeAppServer(rateLimitsResult: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-app-server-'));
  codexScratch.push(dir);
  const bin = join(dir, 'codex');
  const body = [
    '#!/usr/bin/env node',
    "let buf = '';",
    "process.stdin.on('data', (d) => {",
    '  buf += d.toString();',
    "  const lines = buf.split('\\n');",
    "  buf = lines.pop() ?? '';",
    '  for (const line of lines) {',
    "    if (!line.trim()) continue;",
    '    const msg = JSON.parse(line);',
    "    if (msg.method === 'initialize') {",
    "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\\n');",
    "    } else if (msg.method === 'account/rateLimits/read') {",
    `      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: ${JSON.stringify(rateLimitsResult)} }) + '\\n');`,
    '    }',
    '  }',
    '});',
  ].join('\n');
  writeFileSync(bin, body, 'utf8');
  chmodSync(bin, 0o755);
  return bin;
}

describe('Codex cloud submission is not settlement', () => {
  for (const submission of ['Created task_task123\n', 'Submission accepted\n']) {
    it(`keeps exposure uncertain for ${submission.trim()}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'codex-cloud-submit-'));
      codexScratch.push(dir);
      const bin = join(dir, 'codex');
      writeFileSync(bin, [
        '#!/usr/bin/env node',
        "const args = process.argv.slice(2);",
        "if (args[0] === 'cloud' && args[1] === 'list') process.stdout.write('[]');",
        "else if (args[0] === 'cloud' && args[1] === 'exec' && args[2] === '--env' && args[3] === 'env_x') {",
        `  process.stdout.write(${JSON.stringify(submission)});`,
        '} else process.exit(1);',
      ].join('\n'), 'utf8');
      chmodSync(bin, 0o755);
      const evidenceDir = join(dir, 'evidence');
      const adapter = new CodexCloudAdapter({ envId: 'env_x', skillEntryVerified: true }, bin);
      const result = await adapter.dispatch({
        taskId: 'task-local', runId: 'run-local', task: 'Exercise submission protocol',
        repoPath: dir, evidenceDir, settings: { acceptVendorDefault: true },
      });
      assert.equal(result.outcome.kind, 'remote-uncertain');
      assert.equal(result.outcome.taskId, 'task-local');
      assert.equal(result.outcome.runId, 'run-local');
      assert.equal(result.sessionId, submission.includes('task_task123') ? 'task_task123' : undefined);
      assert.equal(readFileSync(result.artifacts!['submission']!, 'utf8'), submission);
      assert.match(result.outcome.nextAction, /codex cloud (status|list)/);
      assert.deepEqual(result.settings.observed, { model: 'unknown', effort: 'unknown' });
    });
  }
});

describe('a rate-limits answer that names no window', () => {
  it('is reported as unavailable, not as a reading with nothing in it', async () => {
    // The server answered, so nothing failed; but an allowance of "nothing known"
    // wearing the shape of a healthy read is what an operator would act on.
    const adapter = new CodexCloudAdapter({ envId: 'env_x' }, fakeAppServer({ rateLimits: { primary: null, secondary: null } }));
    const result = await adapter.readUsage();
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.unavailable.reason : '', /no window/i);
  });

  it('reports a reading when the answer does carry one', async () => {
    const adapter = new CodexCloudAdapter(
      { envId: 'env_x' },
      fakeAppServer({ rateLimits: { primary: { usedPercent: 36, windowDurationMins: 10080 }, secondary: null } }),
    );
    const result = await adapter.readUsage();
    assert.equal(result.ok, true);
    assert.equal(result.ok === true ? result.reading.windows.length : 0, 1);
  });
});
