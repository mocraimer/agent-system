import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import type { DispatchInput, DispatchResult, RuntimeAdapter, RuntimeCapabilities } from '../adapters/types.js';
import { createCoordinatorCommands } from '../commands.js';
import type { CandidateIdentity } from '../core/run.js';
import type { Outcome } from '../core/outcome.js';
import type { UsageResult } from '../core/usage.js';
import { writeJson } from '../core/store.js';
import { OPERATOR, sandbox } from '../core/testkit.js';
import {
  MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, MCP_TOOL_DEFINITIONS, McpServer,
} from './server.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.js');
const CANDIDATE: CandidateIdentity = {
  repo: 'example/consumer',
  base: 'main',
  head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

const CAPS: RuntimeCapabilities = {
  runtime: 'pi-local',
  subscriptionId: 'isolated-test-subscription',
  supportsModelSelection: true,
  supportsEffortSelection: true,
  effortLevels: ['low', 'high'],
  reportsEffectiveSettings: true,
  acceptsCallerSessionId: true,
  skillInvocationForm: '/skill:auto <task>',
};

class FakeAdapter implements RuntimeAdapter {
  readonly capabilities = CAPS;
  usageCalls = 0;
  dispatchCalls = 0;
  readinessCalls = 0;
  reconcileCalls = 0;
  dispatchKind: DispatchResult['outcome']['kind'] = 'completed';

  constructor(
    public usage: UsageResult = {
      ok: true,
      reading: {
        subscriptionId: CAPS.subscriptionId,
        observedAt: new Date().toISOString(),
        source: 'isolated test adapter',
        windows: [
          { kind: 'five-hour', usedPercent: 1, vendorLabel: 'five-hour' },
          { kind: 'weekly', usedPercent: 1, vendorLabel: 'weekly' },
        ],
      },
    },
    private readonly readiness: Outcome | undefined = undefined,
    dispatchKind: DispatchResult['outcome']['kind'] = 'completed',
  ) {
    this.dispatchKind = dispatchKind;
  }

  readUsage(): Promise<UsageResult> {
    this.usageCalls++;
    return Promise.resolve(this.usage);
  }

  checkReadiness(): Promise<Outcome | undefined> {
    this.readinessCalls++;
    return Promise.resolve(this.readiness);
  }

  dispatch(input: DispatchInput): Promise<DispatchResult> {
    this.dispatchCalls++;
    return Promise.resolve({
      outcome: {
        kind: this.dispatchKind,
        taskId: input.taskId,
        runId: input.runId,
        summary: this.dispatchKind === 'remote-uncertain' ? 'isolated adapter cannot confirm the session' : 'isolated adapter settled',
        nextAction: 'Review the run evidence.',
      },
      settings: {
        requested: {
          model: input.settings.model ?? 'vendor-default',
          effort: input.settings.effort ?? 'vendor-default',
        },
        resolved: { model: input.settings.model ?? 'test-model', effort: input.settings.effort ?? 'high' },
        observed: { model: input.settings.model ?? 'test-model', effort: input.settings.effort ?? 'high' },
      },
    });
  }

  reconcile(): Promise<Outcome> {
    this.reconcileCalls++;
    return Promise.resolve({
      kind: 'remote-uncertain',
      summary: 'isolated adapter cannot confirm the session',
      nextAction: 'Inspect the session before retrying.',
    });
  }
}

function initializedServer(adapter = new FakeAdapter()): { server: McpServer; adapter: FakeAdapter } {
  const commands = createCoordinatorCommands((_runtime) => adapter);
  return { server: new McpServer(commands), adapter };
}

async function initialize(server: McpServer): Promise<void> {
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'isolated-test-client', version: '1' },
    },
  });
  assert.equal(response?.error, undefined);
  assert.equal((response?.result as { serverInfo: { name: string } }).serverInfo.name, MCP_SERVER_NAME);
}

function toolData(response: Awaited<ReturnType<McpServer['handle']>>): Record<string, unknown> {
  assert.ok(response?.result, 'expected a JSON-RPC result');
  const result = response.result as { structuredContent?: unknown };
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object');
  return result.structuredContent as Record<string, unknown>;
}

function call(name: string, args: Record<string, unknown> = {}, id = name) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function staleEvidence(check: string) {
  return {
    check,
    class: 'real-provider',
    reportedOutcome: 'passed',
    candidate: CANDIDATE,
    observedAt: '2020-01-01T00:00:00.000Z',
    source: 'isolated fixture',
  };
}

describe('MCP tool surface', () => {
  it('offers views and dispatch, but no authority or policy mutation tools', async () => {
    const s = sandbox();
    try {
      const { server } = initializedServer();
      const before = await server.handle({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} });
      assert.equal(before?.error?.code, -32002);
      await initialize(server);
      const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      const tools = (response?.result as { tools: Array<{ name: string }> }).tools;
      assert.deepEqual(tools.map((tool) => tool.name), ['status', 'jobs', 'usage', 'readiness', 'evidence', 'evaluation', 'dispatch']);
      assert.equal(MCP_TOOL_DEFINITIONS.some((tool) => tool.name.includes('grant') || tool.name.includes('approve')), false);
      const evidence = toolData(await server.handle(call('evidence', { candidate: CANDIDATE }, 'empty-checks')));
      assert.equal((evidence['configuration'] as { valid: boolean }).valid, false, 'an empty check list cannot claim acceptance');
    } finally {
      s.cleanup();
    }
  });

  it('returns a pending proposal without invoking adapters or creating approval', async () => {
    const s = sandbox();
    try {
      const { server, adapter } = initializedServer();
      await initialize(server);
      const response = await server.handle(call('dispatch', {
        taskId: 'pending_task', repo: 'example/consumer', workClass: 'ci-repair',
        runtime: 'pi-local', profile: 'default', actions: ['author-changes'], prompt: 'bounded task',
      }));
      const data = toolData(response);
      assert.equal(data['status'], 'awaiting-approval');
      const proposal = data['proposal'] as { issued: boolean; operatorPath: string };
      assert.equal(proposal.issued, false);
      assert.match(proposal.operatorPath, /agentsys approve --as <operator-id>/);
      assert.equal(adapter.usageCalls, 0);
      assert.equal(adapter.dispatchCalls, 0);
      assert.deepEqual(createCoordinatorCommands((_runtime) => adapter).approvalList(), []);
    } finally {
      s.cleanup();
    }
  });

  /**
   * The proposal names the scope the operator is asked to approve. A tier left
   * out of it is a tier the retry is not constrained to, so the approval the
   * operator reviewed and the authority it grants would differ.
   */
  it('carries the requested tier into the approval it tells the operator to mint', async () => {
    const s = sandbox();
    try {
      const { server, adapter } = initializedServer();
      await initialize(server);
      const response = await server.handle(call('dispatch', {
        taskId: 'pending_tiered', repo: 'example/consumer', workClass: 'ci-repair',
        runtime: 'pi-local', profile: 'default', actions: ['author-changes'], prompt: 'bounded task',
        settings: { model: 'gpt-5.6-luna', effort: 'max' },
      }));
      const proposal = toolData(response)['proposal'] as { operatorPath: string };
      assert.match(proposal.operatorPath, /--model "gpt-5\.6-luna"/);
      assert.match(proposal.operatorPath, /--effort "max"/);
      assert.equal(adapter.dispatchCalls, 0);
    } finally {
      s.cleanup();
    }
  });

  it('omits the tier flags when the caller named no tier', async () => {
    const s = sandbox();
    try {
      const { server } = initializedServer();
      await initialize(server);
      const response = await server.handle(call('dispatch', {
        taskId: 'pending_untiered', repo: 'example/consumer', workClass: 'ci-repair',
        runtime: 'pi-local', profile: 'default', actions: ['author-changes'], prompt: 'bounded task',
      }));
      const proposal = toolData(response)['proposal'] as { operatorPath: string };
      assert.ok(!proposal.operatorPath.includes('--model'), proposal.operatorPath);
      assert.ok(!proposal.operatorPath.includes('--effort'), proposal.operatorPath);
    } finally {
      s.cleanup();
    }
  });

  it('rejects operator identity injection and unknown mutation tools', async () => {
    const s = sandbox();
    try {
      const { server } = initializedServer();
      await initialize(server);
      const forged = await server.handle(call('dispatch', {
        taskId: 'forged', repo: 'example/consumer', workClass: 'ci-repair',
        runtime: 'pi-local', profile: 'default', actions: ['author-changes'], prompt: 'x',
        as: OPERATOR.id,
      }, 'forged'));
      assert.equal(forged?.error?.code, -32602);
      assert.match(forged?.error?.message ?? '', /operator identity/);

      const mutation = await server.handle(call('grantCreate', {}, 'mutation'));
      assert.equal(mutation?.error?.code, -32602);
      assert.deepEqual(createCoordinatorCommands((_runtime) => new FakeAdapter()).grantList(), []);
    } finally {
      s.cleanup();
    }
  });

  it('uses the existing approval and shared admission path for bounded dispatch', async () => {
    const s = sandbox();
    try {
      const adapter = new FakeAdapter();
      const layer = createCoordinatorCommands((_runtime) => adapter);
      const approval = layer.approve(OPERATOR, {
        repo: 'example/consumer', taskScope: 'bounded task', workClass: 'ci-repair',
        runtime: 'pi-local', profile: 'default', actions: ['author-changes'],
        limits: { maxAttempts: 1, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      });
      const server = new McpServer(layer);
      await initialize(server);
      const response = await server.handle(call('dispatch', {
        taskId: 'approved_task', repo: 'example/consumer', workClass: 'ci-repair',
        runtime: 'pi-local', profile: 'default', actions: ['author-changes'], prompt: 'bounded task',
        approvalId: approval.id,
        estimate: {
          fiveHourPercent: 1, weeklyPercent: 1, basis: 'operator-bound',
          uncertaintyPercent: 1, detail: 'isolated bound',
        },
      }, 'approved'));
      const data = toolData(response);
      assert.equal(data['status'], 'completed');
      assert.equal(data['attempted'], true);
      assert.equal((data['authority'] as { id: string }).id, approval.id);
      assert.equal(adapter.usageCalls, 1);
      assert.equal(adapter.dispatchCalls, 1);
      const cards = toolData(await server.handle(call('evaluation', { view: 'scorecards' })));
      assert.equal((cards['scorecards'] as Array<{ finalStatus: string }>)[0]?.finalStatus, 'completed');

      const id = 'card_approved_task';
      layer.checkResultRecord(OPERATOR, id, { name: 'unit', outcome: 'failed', source: 'unit.log', head: CANDIDATE.head });
      layer.reviewRecord(OPERATOR, id, {
        author: 'author', reviewer: { id: 'reviewer', relationship: 'independent' },
        source: 'review.log', head: CANDIDATE.head, findings: [{ severity: 'high', summary: 'MCP detail-only finding' }],
      });
      layer.repairRecord(OPERATOR, id, { trigger: 'review-finding', detail: 'MCP detail-only repair', head: 'b'.repeat(40) });
      layer.reviewRecord(OPERATOR, id, {
        author: 'author', reviewer: { id: 'reviewer', relationship: 'independent' },
        source: 'followup.log', head: 'b'.repeat(40), findings: [],
      });
      for (const filter of [{}, { repo: 'example/consumer' }, { repo: 'other/repo' }]) {
        const detail = toolData(await server.handle(call('evaluation', { ...filter, view: 'scorecards' })));
        const { evidence, recordedAttempts, ...aggregates } = detail['report'] as Record<string, unknown>;
        const count = filter.repo === 'other/repo' ? 0 : 1;
        assert.equal((evidence as unknown[]).length, count);
        assert.equal((recordedAttempts as unknown[]).length, count, 'detailed view retains recorded attempts');
        assert.equal((detail['scorecards'] as unknown[]).length, count);
        if (count) {
          assert.match(JSON.stringify(detail), /MCP detail-only finding/);
          assert.match(JSON.stringify(detail), /MCP detail-only repair/);
          assert.equal((evidence as Array<{ reviews: unknown[] }>)[0]?.reviews.length, 2);
        }
        for (const selection of [{}, { view: 'summary' }]) {
          const response = await server.handle(call('evaluation', { ...filter, ...selection }));
          const summary = toolData(response);
          assert.deepEqual(summary['scorecards'], { report: aggregates, count });
          assert.equal('recordedAttempts' in (summary['scorecards'] as { report: object }).report, false, 'aggregate summary omits per-attempt detail');
          // Check the whole wire response, including both text and structured content.
          assert.doesNotMatch(JSON.stringify(response), /MCP detail-only|reviewerFindings|findingCount/);
          const text = (response?.result as { content: Array<{ text: string }> }).content[0]!.text;
          assert.deepEqual(JSON.parse(text), summary);
        }
      }
    } finally {
      s.cleanup();
    }
  });

  it('persists quota refusals through MCP without a runtime call or attempt consumption', async () => {
    const s = sandbox();
    try {
      const unavailable: UsageResult = {
        ok: false,
        unavailable: {
          subscriptionId: CAPS.subscriptionId,
          attemptedAt: new Date().toISOString(),
          source: 'isolated adapter',
          reason: 'subscription usage is unavailable',
          operatorAction: 'Refresh usage, then retry.',
        },
      };
      const adapter = new FakeAdapter(unavailable);
      const layer = createCoordinatorCommands((_runtime) => adapter);
      const approval = layer.approve(OPERATOR, {
        repo: 'example/consumer', taskScope: 'bounded task', workClass: 'ci-repair',
        runtime: 'pi-local', profile: 'default', actions: ['author-changes'],
        limits: { maxAttempts: 1, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      });
      const server = new McpServer(layer);
      await initialize(server);
      const args = {
        taskId: 'mcp_quota_task', repo: 'example/consumer', workClass: 'ci-repair',
        runtime: 'pi-local', profile: 'default', actions: ['author-changes'], prompt: 'bounded task',
        approvalId: approval.id,
        estimate: { fiveHourPercent: 1, weeklyPercent: 1, basis: 'operator-bound', uncertaintyPercent: 1, detail: 'isolated bound' },
      };
      const refused = toolData(await server.handle(call('dispatch', args, 'quota')));
      assert.equal(refused['status'], 'quota-waiting');
      assert.equal(refused['attempted'], false, 'the retained quota refusal did not reach runtime dispatch');
      assert.equal((refused['run'] as { status: string }).status, 'quota-waiting');
      assert.equal(adapter.usageCalls, 1);
      assert.equal(adapter.dispatchCalls, 0, 'quota refusal must not invoke runtime dispatch');
      assert.equal(adapter.reconcileCalls, 0);
      const refusedCards = toolData(await server.handle(call('evaluation', { view: 'scorecards' }, 'quota-cards')));
      const refusedCard = (refusedCards['scorecards'] as Array<{ finalStatus: string; blockers: string[]; usage: { deltaContaminated?: boolean } }>)[0];
      assert.equal(refusedCard?.finalStatus, 'quota-waiting');
      assert.deepEqual(refusedCard?.blockers, [(refused['outcome'] as { summary: string }).summary]);
      assert.equal(refusedCard?.usage.deltaContaminated, true);

      // A retained quota refusal is not an attempt. The same one-attempt approval
      // can dispatch once usage becomes available, exactly once.
      adapter.usage = new FakeAdapter().usage;
      const completed = toolData(await server.handle(call('dispatch', args, 'retry')));
      assert.equal(completed['status'], 'completed');
      assert.equal(adapter.dispatchCalls, 1);
      const status = toolData(await server.handle(call('status', { taskId: 'mcp_quota_task' }, 'quota-status')));
      const statuses = (status['runs'] as Array<{ run: { status: string } }>).map(({ run }) => run.status);
      assert.equal(statuses.filter((value) => value === 'quota-waiting').length, 1);
      assert.equal(statuses.filter((value) => value === 'completed').length, 1);
    } finally {
      s.cleanup();
    }
  });

  it('persists a remote-uncertain MCP outcome and keeps it unresolved', async () => {
    const s = sandbox();
    try {
      const adapter = new FakeAdapter(undefined, undefined, 'remote-uncertain');
      const layer = createCoordinatorCommands((_runtime) => adapter);
      const approval = layer.approve(OPERATOR, {
        repo: 'example/consumer', taskScope: 'bounded task', workClass: 'ci-repair',
        runtime: 'pi-local', profile: 'default', actions: ['author-changes'],
        limits: { maxAttempts: 2, maxConcurrentRuns: 1, maxPaidCallUsd: 1 },
      });
      const server = new McpServer(layer);
      await initialize(server);
      const response = toolData(await server.handle(call('dispatch', {
        taskId: 'mcp_uncertain_task', repo: 'example/consumer', workClass: 'ci-repair',
        runtime: 'pi-local', profile: 'default', actions: ['author-changes'], prompt: 'bounded task',
        approvalId: approval.id,
        estimate: { fiveHourPercent: 1, weeklyPercent: 1, basis: 'operator-bound', uncertaintyPercent: 1, detail: 'isolated bound' },
      }, 'uncertain')));
      assert.equal(response['status'], 'remote-uncertain');
      assert.equal(response['attempted'], true);
      assert.equal(adapter.dispatchCalls, 1);
      const cards = toolData(await server.handle(call('evaluation', { view: 'scorecards' })));
      const card = (cards['scorecards'] as Array<{ finalStatus: string; blockers: string[] }>)[0];
      assert.equal(card?.finalStatus, 'remote-uncertain');
      assert.deepEqual(card?.blockers, [(response['outcome'] as { summary: string }).summary]);
      const status = toolData(await server.handle(call('status', { taskId: 'mcp_uncertain_task' })));
      assert.equal((status['runs'] as Array<{ active: boolean }>)[0]?.active, true);
      const retry = toolData(await server.handle(call('dispatch', {
        taskId: 'mcp_uncertain_task', repo: 'example/consumer', workClass: 'ci-repair',
        runtime: 'pi-local', profile: 'default', actions: ['author-changes'], prompt: 'bounded task',
        approvalId: approval.id,
        estimate: { fiveHourPercent: 1, weeklyPercent: 1, basis: 'operator-bound', uncertaintyPercent: 1, detail: 'isolated bound' },
      }, 'uncertain-retry')));
      assert.equal(retry['status'], 'remote-uncertain');
      assert.equal(retry['attempted'], false);
      assert.equal(adapter.dispatchCalls, 1, 'an unresolved remote run must not be dispatched a second time');
    } finally {
      s.cleanup();
    }
  });

  it('preserves missing, stale, and deferred evidence states', async () => {
    const s = sandbox();
    try {
      writeJson(join(s.root, 'required-checks.json'), [
        { name: 'web-check', requiredClass: 'real-provider' },
        {
          name: 'native-check', requiredClass: 'native',
          deferral: { reason: 'native work is deferred', deferredBy: OPERATOR.id, deferredAt: new Date().toISOString() },
        },
      ]);
      const { server } = initializedServer();
      await initialize(server);
      const missing = toolData(await server.handle(call('evidence', {
        candidate: CANDIDATE,
        evidence: [staleEvidence('web-check')],
      })));
      const report = missing['report'] as {
        accepted: boolean;
        deferred: string[];
        verdicts: Array<{ check: string; deferred?: boolean; disqualifier?: string }>;
      };
      assert.equal(report.accepted, false);
      assert.deepEqual(report.deferred, ['native-check']);
      assert.deepEqual(report.verdicts.find((v) => v.check === 'web-check')?.disqualifier, 'stale');
      assert.equal(report.verdicts.find((v) => v.check === 'native-check')?.deferred, true);

      const noEvidence = toolData(await server.handle(call('evidence', { candidate: CANDIDATE }, 'missing')));
      const missingVerdict = (noEvidence['report'] as { verdicts: Array<{ check: string; disqualifier?: string }> }).verdicts
        .find((v) => v.check === 'web-check');
      assert.equal(missingVerdict?.disqualifier, 'missing');
    } finally {
      s.cleanup();
    }
  });

  it('keeps unavailable usage and setup outcomes explicit', async () => {
    const s = sandbox();
    try {
      const unavailable: UsageResult = {
        ok: false,
        unavailable: {
          subscriptionId: CAPS.subscriptionId,
          attemptedAt: new Date().toISOString(),
          source: 'isolated adapter',
          reason: 'credential unavailable',
          operatorAction: 'Sign in, then retry.',
        },
      };
      const setup: Outcome = {
        kind: 'setup-blocked',
        summary: 'test setup is incomplete',
        nextAction: 'Complete the setup.',
      };
      const adapter = new FakeAdapter(unavailable, setup);
      const { server } = initializedServer(adapter);
      await initialize(server);
      const usage = toolData(await server.handle(call('usage', { runtime: 'pi-local' })));
      const usageResult = ((usage['runtimes'] as Array<{ result: UsageResult }>)[0]!).result;
      assert.equal(usageResult.ok, false);
      const readiness = toolData(await server.handle(call('readiness', { runtime: 'pi-local' })));
      assert.equal((readiness['runtimes'] as Array<{ ready: boolean }>)[0]!.ready, false);
      assert.equal(adapter.usageCalls, 1);
      assert.equal(adapter.readinessCalls, 1);
    } finally {
      s.cleanup();
    }
  });
});

describe('MCP stdio protocol integration', () => {
  it('completes initialize, tools/list, tools/call, and protocol errors in a real child process', async () => {
    const s = sandbox();
    try {
      const messages = [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'child', version: '1' } } }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'jobs', arguments: {} } }),
        JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dispatch', arguments: { taskId: 'x', repo: 'example/r', workClass: 'ci-repair', runtime: 'pi-local', profile: 'default', actions: ['author-changes'], prompt: 'x', as: 'operator@example.test' } } }),
        JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'does/not-exist', params: {} }),
        '{not-json',
      ].join('\n') + '\n';
      const child = spawn(process.execPath, [SERVER], {
        env: { ...process.env, AGENTSYS_STATE: s.root },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: string[] = [];
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk.toString('utf8')); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.stdin.end(messages);
      const exitCode = await new Promise<number>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolveExit(code ?? -1));
      });
      assert.equal(exitCode, 0, stderr);
      const responses = stdout.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
        id?: number | null; result?: Record<string, unknown>; error?: { code: number; message: string };
      });
      const byId = new Map(responses.map((response) => [response.id, response]));
      assert.equal((byId.get(1)?.result as { serverInfo: { name: string } }).serverInfo.name, MCP_SERVER_NAME);
      assert.equal((byId.get(2)?.result as { tools: unknown[] }).tools.length, 7);
      assert.deepEqual((byId.get(3)?.result as { structuredContent: { jobs: unknown[] } }).structuredContent.jobs, []);
      assert.equal(byId.get(4)?.error?.code, -32602);
      assert.equal(byId.get(5)?.error?.code, -32601);
      assert.ok(responses.some((response) => response.error?.code === -32700), 'malformed JSON must receive a parse error');
      assert.ok(stdout.every((chunk) => chunk.trim().split('\n').every((line) => line.startsWith('{'))), 'stdout must contain protocol JSON only');
    } finally {
      s.cleanup();
    }
  });

  it('accepts a fragmented UTF-8/CRLF stream and suppresses notification responses', async () => {
    const s = sandbox();
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const chunks: string[] = [];
      output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
      const layer = createCoordinatorCommands((_runtime) => new FakeAdapter());
      // Exercise the real framing loop with a fresh server process-like stream and
      // ensure CRLF is accepted at the record edge.
      const serving = (await import('./server.js')).serveStdio(layer, input, output);
      input.write('{"jsonrpc":"2.0","id":"a","method":"initialize","params":{}}\r');
      input.write('\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      input.write('{"jsonrpc":"2.0","id":"b","method":"tools/call","params":{"name":"jobs","arguments":{}}}\n');
      input.end();
      await serving;
      const responses = chunks.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { id?: string; result?: unknown });
      assert.deepEqual(responses.map((response) => response.id), ['a', 'b']);
    } finally {
      s.cleanup();
    }
  });
});
