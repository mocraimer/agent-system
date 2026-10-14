import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { CLAUDE_WEB_CAPABILITIES, ClaudeWebAdapter, parseUsageWindows } from './claude-web.js';

/**
 * The verbatim report from a real `/usage` call on 2026-09-08, kept as a fixture
 * so the parser is tested against the vendor's actual wording rather than a
 * paraphrase of it that would keep passing after the wording changed.
 */
const REAL_REPORT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'claude-usage-report.txt'),
  'utf8',
);

describe('parsing a real /usage report', () => {
  const windows = parseUsageWindows(REAL_REPORT);

  it('finds the account-wide five-hour window', () => {
    const w = windows.find((x) => x.kind === 'five-hour');
    assert.equal(w?.usedPercent, 19);
    assert.equal(w?.vendorLabel, 'Current session');
    assert.match(w?.resetsAt ?? '', /Sep 9/);
  });

  it('finds the account-wide weekly window', () => {
    const w = windows.find((x) => x.kind === 'weekly');
    assert.equal(w?.usedPercent, 27);
    assert.equal(w?.vendorLabel, 'Current week (all models)');
  });

  it('does not treat a model-specific weekly bucket as the account weekly one', () => {
    const weekly = windows.filter((x) => x.kind === 'weekly');
    assert.equal(weekly.length, 1, 'only "all models" is the account weekly limit');
    const fable = windows.find((x) => x.vendorLabel.includes('Fable'));
    assert.equal(fable?.usedPercent, 38);
    assert.equal(fable?.kind, 'other', 'a per-model limit is its own bucket');
  });

  it('stops before the local-attribution breakdown', () => {
    // Those lines carry percentages too ("63% of your usage was at >150k context")
    // but are explicitly local-machine attribution, not account allowance.
    assert.ok(REAL_REPORT.includes("What's contributing"), 'fixture still has the section');
    assert.equal(windows.length, 3, 'only the three window lines are read');
  });

  it('reports nothing rather than guessing when the report is empty', () => {
    assert.deepEqual(parseUsageWindows(''), []);
    assert.deepEqual(parseUsageWindows('some unrelated text'), []);
  });
});

describe('Claude cloud readiness', () => {
  it('reports a setup blocker when no cloud session is configured', async () => {
    const adapter = new ClaudeWebAdapter('claude');
    const outcome = await adapter.checkReadiness();
    assert.equal(outcome?.kind, 'setup-blocked');
    assert.match(outcome?.summary ?? '', /cannot create one/);
    // Both creation paths were tried against the real CLI and both refused. The
    // message quotes them so an operator does not retry what is already settled.
    assert.match(outcome?.summary ?? '', /requires an interactive terminal/);
    assert.match(outcome?.summary ?? '', /different backends/);
    assert.match(outcome?.nextAction ?? '', /claude --cloud/);
  });
});

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A stand-in `claude` that retains argv and returns a controlled CLI response. */
function fakeClaude(stdout: string, code = 0): string {
  const bin = join(tempDir('claude-web-test-'), 'claude');
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    "const { appendFileSync } = require('node:fs');",
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(`${bin}.argv.jsonl`)}, JSON.stringify(args) + '\\n');`,
    `process.stdout.write(${JSON.stringify(stdout)});`,
    `process.exit(args[0] === 'auth' ? 0 : ${code});`,
  ].join('\n'), 'utf8');
  chmodSync(bin, 0o755);
  return bin;
}

function dispatchInput(evidenceDir: string) {
  return {
    taskId: 't-1',
    runId: 'run_1',
    task: 'do the bounded thing',
    repoPath: process.cwd(),
    settings: { model: 'opus', effort: 'high' },
    evidenceDir,
  };
}

describe('attaching to a cloud session', () => {
  // The real acknowledgement, verbatim from `claude --cloud <id> -p ... --output-format json`
  // on 2026-09-09. It carries no `result`, because the run continues on the vendor's side.
  const ACK = '{"ok":true,"session_id":"session_01HWA4","url":"https://claude.ai/code/session_01HWA4?from=cli&m=0"}';

  it('does not report a completed run when the prompt was only accepted', async () => {
    const evidenceDir = tempDir('claude-web-evidence-');
    const adapter = new ClaudeWebAdapter(fakeClaude(ACK), 'session_01HWA4');

    const result = await adapter.dispatch(dispatchInput(evidenceDir));

    assert.equal(result.outcome.kind, 'remote-uncertain');
    assert.notEqual(result.outcome.kind, 'completed');
    assert.equal(result.skill?.continuation, 'running');
    assert.equal(result.sessionId, 'session_01HWA4');
  });

  it('points at the session and warns against a second attempt', async () => {
    const evidenceDir = tempDir('claude-web-evidence-');
    const adapter = new ClaudeWebAdapter(fakeClaude(ACK), 'session_01HWA4');

    const result = await adapter.dispatch(dispatchInput(evidenceDir));

    assert.match(result.outcome.nextAction, /claude\.ai\/code/);
    assert.match(result.outcome.nextAction, /Do not dispatch this task again/);
  });

  it('retains the acknowledgement it actually received', async () => {
    const evidenceDir = tempDir('claude-web-evidence-');
    const adapter = new ClaudeWebAdapter(fakeClaude(ACK), 'session_01HWA4');

    const result = await adapter.dispatch(dispatchInput(evidenceDir));

    const kept = result.artifacts?.['acknowledgement'];
    assert.ok(kept, 'the acknowledgement is the only evidence this run produced');
    assert.equal(JSON.parse(readFileSync(kept, 'utf8')).session_id, 'session_01HWA4');
  });

  it('records the effective model and effort as unknown, not as what was asked for', async () => {
    // The acknowledgement reports nothing about what the vendor session ran with,
    // so echoing "opus"/"high" back would dress a request up as a confirmation.
    const evidenceDir = tempDir('claude-web-evidence-');
    const adapter = new ClaudeWebAdapter(fakeClaude(ACK), 'session_01HWA4');

    const result = await adapter.dispatch(dispatchInput(evidenceDir));

    assert.equal(result.settings.resolved.model, 'opus');
    assert.equal(result.settings.observed.model, 'unknown');
    assert.equal(result.settings.observed.effort, 'unknown');
  });

  it('still completes a response that does carry a result', async () => {
    // Guards the branch above: it must key on the missing result, not report
    // every cloud dispatch as outstanding regardless of what came back.
    const evidenceDir = tempDir('claude-web-evidence-');
    const withResult = '{"session_id":"session_01HWA4","is_error":false,"result":"all done"}';
    const adapter = new ClaudeWebAdapter(fakeClaude(withResult), 'session_01HWA4');

    const result = await adapter.dispatch(dispatchInput(evidenceDir));

    assert.equal(result.outcome.kind, 'completed');
    assert.equal(result.skill?.continuation, 'completed');
  });
});

describe('cloud model migration at the subprocess boundary', () => {
  const ACK = JSON.stringify({ ok: true, session_id: 'session-test' });

  for (const [label, settings, approvedTier, model, effort] of [
    ['future default', {}, undefined, 'claude-opus-5-5', 'high'],
    ['explicit old request', { model: 'claude-opus-5', effort: 'medium' }, undefined, 'claude-opus-5', 'medium'],
    ['explicit alias request', { model: 'opus', effort: 'high' }, undefined, 'opus', 'high'],
    ['old approval', {}, { model: 'claude-opus-5', effort: 'medium' }, 'claude-opus-5', 'medium'],
    ['alias approval', {}, { model: 'opus', effort: 'high' }, 'opus', 'high'],
    ['other family', { model: 'claude-fable-5-1', effort: 'xhigh' }, undefined, 'claude-fable-5-1', 'xhigh'],
  ] as const) {
    it(`sends ${label} unchanged and leaves acknowledgement settings unknown`, async () => {
      const bin = fakeClaude(ACK);
      const adapter = new ClaudeWebAdapter(bin, 'session-test');
      const result = await adapter.dispatch({ ...dispatchInput(tempDir('cloud-tier-')), settings, ...(approvedTier ? { approvedTier } : {}) });
      const calls = readFileSync(`${bin}.argv.jsonl`, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
      const dispatches = calls.filter((args) => args.includes('-p'));
      assert.equal(dispatches.length, 1);
      const args = dispatches[0]!;
      assert.equal(args[args.indexOf('--model') + 1], model);
      assert.equal(args[args.indexOf('--effort') + 1], effort);
      assert.equal(args.includes('--fallback-model'), false);
      assert.deepEqual(result.settings.resolved, { model, effort });
      assert.deepEqual(result.settings.observed, { model: 'unknown', effort: 'unknown' });
      assert.equal(result.outcome.kind, 'remote-uncertain');
    });
  }

  for (const [label, response, outcome] of [
    ['refusal', { is_error: false, result: 'Cannot help.', stop_reason: 'refusal' }, 'checks-failed'],
    ['unsupported model', { is_error: true, errors: ['Model claude-opus-5-5 is unavailable.'] }, 'checks-failed'],
    ['rejected acknowledgement', { ok: false }, 'checks-failed'],
    ['unknown acknowledgement', {}, 'remote-uncertain'],
    ['non-string result', { result: { text: 'not a result string' } }, 'remote-uncertain'],
  ] as const) {
    it(`does not claim accepted or completed work for ${label}`, async () => {
      const adapter = new ClaudeWebAdapter(fakeClaude(JSON.stringify(response)), 'session-test');
      const result = await adapter.dispatch({ ...dispatchInput(tempDir('cloud-failure-')), settings: {} });
      assert.equal(result.outcome.kind, outcome);
      assert.doesNotMatch(result.outcome.summary, /accepted the prompt|session completed/);
      assert.notEqual(result.skill?.continuation, 'completed');
      assert.deepEqual(result.settings.observed, { model: 'unknown', effort: 'unknown' });
      assert.ok(result.outcome.nextAction);
      assert.ok(result.artifacts, 'the response remains available for inspection');
    });
  }

  it('retains uncertainty on a failed command without retrying or confirming a model', async () => {
    const bin = fakeClaude('Model claude-opus-5-5 unavailable', 1);
    const adapter = new ClaudeWebAdapter(bin, 'session-test');
    const result = await adapter.dispatch({ ...dispatchInput(tempDir('cloud-exit-')), settings: {} });
    assert.equal(result.outcome.kind, 'remote-uncertain');
    assert.match(result.outcome.nextAction, /Reconcile/);
    assert.deepEqual(result.settings.observed, { model: 'unknown', effort: 'unknown' });
    assert.equal(readFileSync(`${bin}.argv.jsonl`, 'utf8').trim().split('\n').length, 2, 'auth plus one dispatch');
  });

  it('never confirms modelUsage from a cloud response, including auxiliary models', async () => {
    const adapter = new ClaudeWebAdapter(fakeClaude(JSON.stringify({
      result: 'Done.', is_error: false, modelUsage: { 'claude-haiku-4-5': {}, 'claude-opus-5-5': {} },
    })), 'session-test');
    const result = await adapter.dispatch({ ...dispatchInput(tempDir('cloud-usage-')), settings: {} });
    assert.equal(result.outcome.kind, 'completed');
    assert.deepEqual(result.settings.observed, { model: 'unknown', effort: 'unknown' });
  });
});

describe('declared capabilities', () => {
  it('shares no subscription with the Codex-backed runtimes', () => {
    assert.equal(CLAUDE_WEB_CAPABILITIES.subscriptionId, 'claude-max');
  });

  it('reports no effective settings, because a cloud attach never returns any', () => {
    assert.equal(CLAUDE_WEB_CAPABILITIES.reportsEffectiveSettings, false);
  });

  it('accepts model and effort, because this runtime really does', () => {
    assert.equal(CLAUDE_WEB_CAPABILITIES.supportsModelSelection, true);
    assert.equal(CLAUDE_WEB_CAPABILITIES.supportsEffortSelection, true);
    assert.deepEqual(CLAUDE_WEB_CAPABILITIES.effortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('naming the account a reading came from', () => {
  // Verbatim shape of `claude auth status`, including the email field that is
  // deliberately not read into the record.
  const AUTH = JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    email: 'someone@example.com',
    orgId: '0f1e2d3c-4b5a-4c6d-8e7f-90a1b2c3d4e5',
    orgName: "someone@example.com's Organization",
    subscriptionType: 'max',
  });

  it('reports the organisation and plan', async () => {
    const adapter = new ClaudeWebAdapter(fakeClaude(AUTH), 'session_01HWA4');
    const account = await adapter.accountIdentity();
    assert.equal(account?.id, '0f1e2d3c-4b5a-4c6d-8e7f-90a1b2c3d4e5');
    assert.equal(account?.plan, 'max');
    assert.equal(account?.source, 'claude auth status');
  });

  it('keeps the email address out of the record', async () => {
    // The organisation id answers "is this the account the runs spend from?".
    // An address would be personal data the record has no use for.
    const adapter = new ClaudeWebAdapter(fakeClaude(AUTH), 'session_01HWA4');
    const account = await adapter.accountIdentity();
    assert.ok(!JSON.stringify(account).includes('@'), 'no address reaches the record');
  });

  it('reports nothing rather than guessing when the account is not named', async () => {
    const adapter = new ClaudeWebAdapter(fakeClaude('{"loggedIn":false}'), 'session_01HWA4');
    assert.equal(await adapter.accountIdentity(), undefined);
  });

  it('does not fail a good usage reading because the account could not be named', async () => {
    // `/usage` succeeded; not knowing the account is a gap in the evidence, not a
    // reason to report the allowance as unreadable.
    const report = 'Current session: 18% used\nCurrent week (all models): 42% used';
    const adapter = new ClaudeWebAdapter(
      fakeClaude(JSON.stringify({ result: report })),
      'session_01HWA4',
    );
    const result = await adapter.readUsage();
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.reading.account, undefined);
    assert.equal(result.ok && result.reading.windows.length, 2);
  });
});

describe('the tier an approval bound the run to', () => {
  const ACK = '{"ok":true,"session_id":"session_01HWA4","url":"https://claude.ai/code/session_01HWA4?from=cli&m=0"}';

  it('is resolved and sent, and still observed as unknown', async () => {
    const evidenceDir = tempDir('claude-web-evidence-');
    const adapter = new ClaudeWebAdapter(fakeClaude(ACK), 'session_01HWA4');

    const result = await adapter.dispatch({
      ...dispatchInput(evidenceDir),
      settings: {},
      approvedTier: { model: 'sonnet', effort: 'xhigh' },
    });

    assert.deepEqual(result.settings.resolved, { model: 'sonnet', effort: 'xhigh' });
    // Sent, never confirmed: this runtime reports nothing back about what it ran.
    assert.deepEqual(result.settings.observed, { model: 'unknown', effort: 'unknown' });
    assert.deepEqual(result.settings.requested, { model: 'vendor-default', effort: 'vendor-default' });
  });
});
