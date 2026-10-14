#!/usr/bin/env node
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { EvidenceItem } from '../core/evidence.js';
import type { CandidateIdentity, SettingsSnapshot } from '../core/run.js';
import type { RuntimeId, ActionId } from '../core/authority.js';
import type { UsageEstimate } from '../core/admission.js';
import type {
  CoordinatorCommands,
  DispatchCommandResult,
  DispatchTaskInput,
  EvaluationInput,
  EvaluationViewName,
  EvidenceInput,
  ReadinessInput,
  StatusInput,
  UsageInput,
} from '../commands.js';
import {
  commands,
  DISPATCH_LIMITS,
  ESTIMATE_BASES,
  RUNTIMES,
  VALID_ACTIONS,
  CommandInputError,
} from '../commands.js';

/** MCP protocol revisions accepted by the local clients this server targets. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];
export const MCP_SERVER_NAME = 'agent-system';
export const MCP_SERVER_VERSION = '0.1.0';

export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  additionalProperties?: boolean | JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

const stringSchema = (description: string, limits: { minLength?: number; maxLength?: number } = {}): JsonSchema => ({
  type: 'string', description, ...limits,
});
const objectSchema = (
  properties: Record<string, JsonSchema>,
  required: string[] = [],
  description?: string,
): JsonSchema => ({
  type: 'object',
  ...(description ? { description } : {}),
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});
const runtimeSchema: JsonSchema = { type: 'string', enum: [...RUNTIMES], description: 'One of the installed coordinator runtimes.' };
const actionSchema: JsonSchema = { type: 'string', enum: [...VALID_ACTIONS], description: 'A coordinator action. Forbidden actions are not exposed.' };
const candidateSchema: JsonSchema = objectSchema({
  repo: stringSchema('Repository identity.', { minLength: 1, maxLength: DISPATCH_LIMITS.identifierLength }),
  base: stringSchema('Base ref.', { minLength: 1, maxLength: DISPATCH_LIMITS.identifierLength }),
  head: stringSchema('Candidate head identity.', { minLength: 1, maxLength: DISPATCH_LIMITS.identifierLength }),
  artifacts: { type: 'object', description: 'Optional artifact name to digest map.', additionalProperties: stringSchema('Artifact digest.', { maxLength: 256 }) },
  backendRevisions: { type: 'object', description: 'Optional backend name to revision map.', additionalProperties: stringSchema('Backend revision.', { maxLength: 256 }) },
}, ['repo', 'base', 'head']);
const evidenceItemSchema: JsonSchema = objectSchema({
  check: stringSchema('Required check name.', { minLength: 1, maxLength: 256 }),
  class: { type: 'string', enum: ['real-provider', 'native', 'emulator', 'mocked', 'judgment'] },
  reportedOutcome: { type: 'string', enum: ['passed', 'failed', 'skipped', 'errored'] },
  candidate: candidateSchema,
  settings: { type: 'object', description: 'Optional runtime setting snapshot.', additionalProperties: true },
  fixtureVersion: stringSchema('Optional fixed fixture/oracle version.', { maxLength: 256 }),
  observedAt: stringSchema('ISO timestamp when this evidence was observed.', { minLength: 1, maxLength: 128 }),
  attempt: { type: 'number', minimum: 1, maximum: 1000 },
  inaccessible: { type: 'boolean' },
  source: stringSchema('Evidence source.', { minLength: 1, maxLength: 4096 }),
}, ['check', 'class', 'reportedOutcome', 'candidate', 'observedAt', 'source']);

export const MCP_TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  {
    name: 'status',
    description: 'Read durable run status and subscription reservations. Remote-uncertain runs remain outstanding; elapsed time is reported, never fake progress.',
    inputSchema: objectSchema({
      taskId: stringSchema('Optional task id filter.', { maxLength: DISPATCH_LIMITS.identifierLength }),
    }),
  },
  {
    name: 'jobs',
    description: 'Read durable jobs, duplicate deliveries, outstanding obligations, and retained evidence directories.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'usage',
    description: 'Read supported runtime account usage, policy thresholds, reset context, and active reservations. Missing usage is returned as unavailable, never as zero.',
    inputSchema: objectSchema({ runtime: runtimeSchema }),
  },
  {
    name: 'readiness',
    description: 'Read runtime setup readiness. Missing login, environment, skill, or hosted capability is returned as a setup blocker.',
    inputSchema: objectSchema({ runtime: runtimeSchema }),
  },
  {
    name: 'evidence',
    description: 'Read required checks and, when supplied, aggregate candidate evidence. Missing, stale, failed, wrong-class, superseded, inaccessible, and deferred evidence remain distinct.',
    inputSchema: objectSchema({
      candidate: candidateSchema,
      evidence: { type: 'array', items: evidenceItemSchema, maxItems: 1000 },
      enforceDeferred: { type: 'array', items: stringSchema('A deferred check to require for this view.', { maxLength: 256 }), maxItems: 100 },
    }),
  },
  {
    name: 'evaluation',
    description: 'Read scorecards, frozen evaluation suites, raw trials, or per-case configuration comparisons. Counts are not reliability rates and no result changes authority.',
    inputSchema: objectSchema({
      view: { type: 'string', enum: ['summary', 'scorecards', 'suites', 'trials', 'compare'] },
      repo: stringSchema('Optional scorecard repository filter.', { maxLength: DISPATCH_LIMITS.identifierLength }),
      workClass: stringSchema('Optional work-class filter.', { maxLength: DISPATCH_LIMITS.identifierLength }),
      runtime: runtimeSchema,
      authorityId: stringSchema('Optional authorizing approval/grant filter.', { maxLength: DISPATCH_LIMITS.identifierLength }),
      effectiveConfiguration: stringSchema('Optional observed model/effort filter.', { maxLength: 512 }),
      workflowVersion: stringSchema('Optional workflow version filter.', { maxLength: 512 }),
      configurationA: stringSchema('First configuration for compare.', { maxLength: 512 }),
      configurationB: stringSchema('Second configuration for compare.', { maxLength: 512 }),
    }),
  },
  {
    name: 'dispatch',
    description: 'Submit one bounded task through the shared coordinator. It can use only an already stored approval or matching active grant; it cannot accept operator identity, create authority, change policy, weaken checks, or merge/deploy/release.',
    inputSchema: objectSchema({
      taskId: stringSchema('Stable task id.', { minLength: 1, maxLength: DISPATCH_LIMITS.identifierLength }),
      repo: stringSchema('Repository identity covered by authority.', { minLength: 1, maxLength: DISPATCH_LIMITS.identifierLength }),
      workClass: stringSchema('Approved work class.', { minLength: 1, maxLength: DISPATCH_LIMITS.identifierLength }),
      runtime: runtimeSchema,
      profile: stringSchema('Runtime profile covered by authority.', { minLength: 1, maxLength: DISPATCH_LIMITS.identifierLength }),
      actions: { type: 'array', items: actionSchema, minItems: 1, maxItems: DISPATCH_LIMITS.maxActions },
      prompt: stringSchema('Bounded task text. It is passed as task data to the selected runtime.', { minLength: 1, maxLength: DISPATCH_LIMITS.promptLength }),
      approvalId: stringSchema('Optional pre-existing approval id. The MCP server never creates one.', { maxLength: DISPATCH_LIMITS.identifierLength }),
      triggerSource: stringSchema('Required for grant-authorized event work.', { maxLength: DISPATCH_LIMITS.identifierLength }),
      prBase: stringSchema('Pull-request base, when open-pr is requested.', { maxLength: DISPATCH_LIMITS.identifierLength }),
      targetProject: stringSchema('Cloud project named by the task, if any.', { maxLength: DISPATCH_LIMITS.identifierLength }),
      repoPath: stringSchema('Optional local checkout path. The process identity is not a sandbox.', { maxLength: 4096 }),
      jobId: stringSchema('Optional existing job id for a retry.', { maxLength: DISPATCH_LIMITS.identifierLength }),
      settings: objectSchema({
        model: stringSchema('Optional runtime-supported model.', { maxLength: 256 }),
        effort: stringSchema('Optional runtime-native effort.', { maxLength: 64 }),
        acceptVendorDefault: { type: 'boolean', description: 'Explicitly accept a vendor-controlled model/effort where required.' },
      }),
      estimate: objectSchema({
        fiveHourPercent: { type: 'number', minimum: 0, maximum: 100 },
        weeklyPercent: { type: 'number', minimum: 0, maximum: 100 },
        basis: { type: 'string', enum: [...ESTIMATE_BASES] },
        uncertaintyPercent: { type: 'number', minimum: 0, maximum: 100 },
        detail: stringSchema('How the estimate was bounded.', { maxLength: DISPATCH_LIMITS.detailLength }),
      }, ['fiveHourPercent', 'weeklyPercent', 'basis', 'uncertaintyPercent', 'detail']),
      timeoutMs: { type: 'number', minimum: 1000, maximum: DISPATCH_LIMITS.maxTimeoutMs },
    }, ['taskId', 'repo', 'workClass', 'runtime', 'profile', 'actions', 'prompt']),
  },
];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class ProtocolError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: unknown;
  isError?: boolean;
}

/** A small MCP server with no dependency on an SDK or network transport. */
export class McpServer {
  private initialized = false;

  constructor(private readonly commandLayer: CoordinatorCommands = commands) {}

  async handle(input: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isRecord(input)) return rpcError(null, -32600, 'Request must be a JSON object.');
    const hasId = Object.prototype.hasOwnProperty.call(input, 'id');
    if (hasId && !isRpcId(input['id'])) {
      return rpcError(null, -32600, 'Request id must be a string, number, or null.');
    }
    const id = isRpcId(input['id']) ? input['id'] : null;
    if (input['jsonrpc'] !== '2.0' || typeof input['method'] !== 'string') {
      return rpcError(id, -32600, 'Request must have jsonrpc "2.0" and a method.');
    }
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      ...(hasId ? { id: input['id'] as string | number | null } : {}),
      method: input['method'],
      ...(Object.prototype.hasOwnProperty.call(input, 'params') ? { params: input['params'] } : {}),
    };
    const notification = !Object.prototype.hasOwnProperty.call(input, 'id');

    try {
      const result = await this.handleMethod(request.method, request.params);
      return notification ? undefined : { jsonrpc: '2.0', id: request.id ?? null, result };
    } catch (err) {
      if (notification) return undefined;
      if (err instanceof ProtocolError) return rpcError(request.id ?? null, err.code, err.message, err.data);
      // Do not send stack traces, paths containing credentials, or raw child-process
      // errors through the client protocol. The operator can inspect stderr/logs.
      return rpcError(request.id ?? null, -32603, safeErrorMessage(err));
    }
  }

  private async handleMethod(method: string, params: unknown): Promise<unknown> {
    if (method === 'notifications/initialized') {
      this.initialized = true;
      return undefined;
    }
    if (method === 'initialize') return this.initialize(params);
    if (method === 'ping') return {};
    if (!this.initialized) {
      throw new ProtocolError(-32002, 'Server is not initialized. Call initialize first.');
    }
    if (method === 'tools/list') {
      assertObjectParams(params, 'tools/list');
      return { tools: MCP_TOOL_DEFINITIONS };
    }
    if (method === 'tools/call') return this.callTool(params);
    throw new ProtocolError(-32601, `Method not found: ${method}`);
  }

  private initialize(params: unknown): Record<string, unknown> {
    const input = assertObjectParams(params, 'initialize');
    const requested = input['protocolVersion'];
    const protocolVersion = typeof requested === 'string' &&
      (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : MCP_PROTOCOL_VERSION;
    this.initialized = true;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      instructions:
        'Read-only coordinator views are available. Dispatch is bounded and requires an existing operator approval or active matching grant. The MCP server never creates authority or accepts operator identity; a local process under the same OS identity is not a security sandbox.',
    };
  }

  private async callTool(params: unknown): Promise<McpToolResult> {
    const input = assertObjectParams(params, 'tools/call');
    const name = input['name'];
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ProtocolError(-32602, 'tools/call requires a non-empty tool name.');
    }
    const tool = MCP_TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
    if (!tool) throw new ProtocolError(-32602, `Unknown tool "${name}".`);
    const rawArguments = input['arguments'] === undefined ? {} : input['arguments'];
    const args = assertRecord(rawArguments, `arguments for ${name}`);

    try {
      const data = await this.executeTool(name, args);
      return toolResult(data);
    } catch (err) {
      if (err instanceof ProtocolError) throw err;
      if (err instanceof CommandInputError) {
        throw new ProtocolError(-32602, err.message);
      }
      return toolError({
        error: 'tool-failed',
        message: safeErrorMessage(err),
        tool: name,
      });
    }
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'status': {
        assertAllowedKeys(args, ['taskId'], name);
        const input: StatusInput = {};
        const taskId = optionalString(args, 'taskId', DISPATCH_LIMITS.identifierLength);
        if (taskId !== undefined) input.taskId = taskId;
        return this.commandLayer.status(input);
      }
      case 'jobs':
        assertAllowedKeys(args, [], name);
        return this.commandLayer.jobs();
      case 'usage': {
        assertAllowedKeys(args, ['runtime'], name);
        const input: UsageInput = {};
        const runtime = optionalRuntime(args, 'runtime');
        if (runtime !== undefined) input.runtime = runtime;
        return await this.commandLayer.usage(input);
      }
      case 'readiness': {
        assertAllowedKeys(args, ['runtime'], name);
        const input: ReadinessInput = {};
        const runtime = optionalRuntime(args, 'runtime');
        if (runtime !== undefined) input.runtime = runtime;
        return await this.commandLayer.readiness(input);
      }
      case 'evidence':
        return this.executeEvidence(args);
      case 'evaluation':
        return this.executeEvaluation(args);
      case 'dispatch':
        return this.executeDispatch(args);
      default:
        throw new ProtocolError(-32602, `Unknown tool "${name}".`);
    }
  }

  private executeEvidence(args: Record<string, unknown>): unknown {
    assertAllowedKeys(args, ['candidate', 'evidence', 'enforceDeferred'], 'evidence');
    const input: EvidenceInput = {};
    if (args['candidate'] !== undefined) input.candidate = parseCandidate(args['candidate']);
    if (args['evidence'] !== undefined) input.evidence = parseEvidenceItems(args['evidence']);
    if (args['enforceDeferred'] !== undefined) input.enforceDeferred = parseStringArray(args['enforceDeferred'], 'enforceDeferred', 100, 256);
    if (input.evidence !== undefined && input.candidate === undefined) {
      throw new ProtocolError(-32602, 'evidence requires candidate when evidence items are supplied.');
    }
    // Freshness is evaluated against the server clock and the configured default.
    // Clients cannot supply `now` or widen maxEvidenceAgeMs to turn stale material green.
    return this.commandLayer.evidence(input);
  }

  private executeEvaluation(args: Record<string, unknown>): unknown {
    const keys = [
      'view', 'repo', 'workClass', 'runtime', 'authorityId', 'effectiveConfiguration',
      'workflowVersion', 'configurationA', 'configurationB',
    ];
    assertAllowedKeys(args, keys, 'evaluation');
    const input: EvaluationInput = {};
    const view = optionalEnum(args, 'view', ['summary', 'scorecards', 'suites', 'trials', 'compare']) as EvaluationViewName | undefined;
    if (view !== undefined) input.view = view;
    for (const key of ['repo', 'workClass', 'authorityId', 'effectiveConfiguration', 'workflowVersion', 'configurationA', 'configurationB'] as const) {
      const value = optionalString(args, key, 512);
      if (value !== undefined) input[key] = value;
    }
    const runtime = optionalRuntime(args, 'runtime');
    if (runtime !== undefined) input.runtime = runtime;
    return this.commandLayer.evaluation(input);
  }

  private async executeDispatch(args: Record<string, unknown>): Promise<unknown> {
    const allowed = [
      'taskId', 'repo', 'workClass', 'runtime', 'profile', 'actions', 'prompt', 'approvalId',
      'triggerSource', 'prBase', 'targetProject', 'repoPath', 'jobId', 'settings', 'estimate', 'timeoutMs',
    ];
    assertAllowedKeys(args, allowed, 'dispatch');
    // Explicitly reject identity-shaped keys even if this list changes later. The
    // server must never turn a string supplied by an agent into operator authority.
    for (const key of ['as', 'operator', 'operatorId', 'actor']) {
      if (Object.prototype.hasOwnProperty.call(args, key)) {
        throw new ProtocolError(-32602, `MCP dispatch does not accept ${key}; only the configured operator can change authority.`);
      }
    }

    const input: DispatchTaskInput = {
      taskId: requiredString(args, 'taskId', DISPATCH_LIMITS.identifierLength),
      repo: requiredString(args, 'repo', DISPATCH_LIMITS.identifierLength),
      workClass: requiredString(args, 'workClass', DISPATCH_LIMITS.identifierLength),
      runtime: requiredRuntime(args, 'runtime'),
      profile: requiredString(args, 'profile', DISPATCH_LIMITS.identifierLength),
      actions: parseActions(args['actions']),
      prompt: requiredString(args, 'prompt', DISPATCH_LIMITS.promptLength),
      settings: parseSettings(args['settings']),
      estimate: parseEstimate(args['estimate']),
    };
    for (const key of ['approvalId', 'triggerSource', 'prBase', 'targetProject', 'repoPath', 'jobId'] as const) {
      const max = key === 'repoPath' ? 4096 : DISPATCH_LIMITS.identifierLength;
      const value = optionalString(args, key, max);
      if (value !== undefined) input[key] = value;
    }
    const timeoutMs = optionalNumber(args, 'timeoutMs', 1000, DISPATCH_LIMITS.maxTimeoutMs);
    if (timeoutMs !== undefined) input.timeoutMs = timeoutMs;

    const result = await this.commandLayer.dispatch(input);
    return dispatchView(input, result);
  }
}

function dispatchView(input: DispatchTaskInput, result: DispatchCommandResult): Record<string, unknown> {
  const pending = result.outcome.kind === 'awaiting-approval';
  return {
    status: result.outcome.kind,
    attempted: result.runtimeDispatched,
    outcome: result.outcome,
    recovered: result.recovered,
    ...(result.authority ? { authority: result.authority } : {}),
    ...(result.limits ? { limits: result.limits } : {}),
    ...(result.admission ? { admission: result.admission } : {}),
    ...(result.run ? { run: result.run } : {}),
    ...(pending ? {
      proposal: {
        humanAuthorityRequired: true,
        operatorPath: operatorApprovalPath(input),
        issued: false,
        note: 'No approval or grant was created. The operator must review and authorize this exact scope outside the MCP call, then call dispatch again with the operator-issued approval or a matching event source.',
      },
    } : {}),
  };
}

/**
 * The command that mints an approval for exactly the scope that was proposed.
 *
 * The tier belongs in it. Without `--model`/`--effort` a pending Luna/max
 * dispatch told the operator to mint an untiered approval, and a retry under it
 * was then free to run at any tier — so the approval the operator reviewed and
 * the authority it granted were not the same thing.
 */
function operatorApprovalPath(input: DispatchTaskInput): string {
  const quote = (value: string): string => JSON.stringify(value);
  return [
    'agentsys approve',
    '--as <operator-id>',
    `--repo ${quote(input.repo)}`,
    `--scope ${quote(input.taskId)}`,
    `--class ${quote(input.workClass)}`,
    `--runtime ${quote(input.runtime)}`,
    `--profile ${quote(input.profile)}`,
    `--actions ${quote(input.actions.join(','))}`,
    ...(input.settings?.model !== undefined ? [`--model ${quote(input.settings.model)}`] : []),
    ...(input.settings?.effort !== undefined ? [`--effort ${quote(input.settings.effort)}`] : []),
  ].join(' ');
}

function toolResult(data: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(data: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: true,
  };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function assertObjectParams(params: unknown, method: string): Record<string, unknown> {
  if (params === undefined) return {};
  return assertRecord(params, `params for ${method}`);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError(-32602, `${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(args: Record<string, unknown>, allowed: string[], tool: string): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    if (unknown.some((key) => ['as', 'operator', 'operatorId', 'actor'].includes(key))) {
      throw new ProtocolError(-32602, `MCP ${tool} does not accept operator identity fields (${unknown.join(', ')}).`);
    }
    throw new ProtocolError(-32602, `Unknown argument(s) for ${tool}: ${unknown.join(', ')}.`);
  }
}

function requiredString(args: Record<string, unknown>, key: string, maxLength: number): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProtocolError(-32602, `${key} is required and must be a non-empty string.`);
  }
  if (value.length > maxLength) throw new ProtocolError(-32602, `${key} exceeds its ${maxLength}-character bound.`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new ProtocolError(-32602, `${key} must be a non-empty string when supplied.`);
  if (value.length > maxLength) throw new ProtocolError(-32602, `${key} exceeds its ${maxLength}-character bound.`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string, minimum: number, maximum: number): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ProtocolError(-32602, `${key} must be a finite number from ${minimum} through ${maximum}.`);
  }
  return value;
}

function optionalEnum(args: Record<string, unknown>, key: string, values: string[]): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value)) throw new ProtocolError(-32602, `${key} must be one of: ${values.join(', ')}.`);
  return value;
}

function optionalRuntime(args: Record<string, unknown>, key: string): RuntimeId | undefined {
  const value = optionalEnum(args, key, [...RUNTIMES]);
  return value as RuntimeId | undefined;
}

function requiredRuntime(args: Record<string, unknown>, key: string): RuntimeId {
  const value = optionalRuntime(args, key);
  if (value === undefined) throw new ProtocolError(-32602, `${key} is required.`);
  return value;
}

function parseActions(value: unknown): ActionId[] {
  const values = parseStringArray(value, 'actions', DISPATCH_LIMITS.maxActions, DISPATCH_LIMITS.identifierLength);
  const unknown = values.filter((action) => !VALID_ACTIONS.includes(action as ActionId));
  if (unknown.length > 0) throw new ProtocolError(-32602, `Unknown action(s): ${unknown.join(', ')}.`);
  return values as ActionId[];
}

function parseStringArray(value: unknown, key: string, maxItems: number, maxItemLength: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new ProtocolError(-32602, `${key} must be a non-empty array of at most ${maxItems} strings.`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '' || item.length > maxItemLength) {
      throw new ProtocolError(-32602, `${key}[${index}] must be a non-empty string of at most ${maxItemLength} characters.`);
    }
    return item;
  });
}

function parseSettings(value: unknown): DispatchTaskInput['settings'] {
  if (value === undefined) return {};
  const input = assertRecord(value, 'settings');
  assertAllowedKeys(input, ['model', 'effort', 'acceptVendorDefault'], 'settings');
  const output: DispatchTaskInput['settings'] = {};
  const model = optionalString(input, 'model', 256);
  const effort = optionalString(input, 'effort', 64);
  if (model !== undefined) output.model = model;
  if (effort !== undefined) output.effort = effort;
  if (input['acceptVendorDefault'] !== undefined) {
    if (typeof input['acceptVendorDefault'] !== 'boolean') throw new ProtocolError(-32602, 'settings.acceptVendorDefault must be boolean.');
    output.acceptVendorDefault = input['acceptVendorDefault'];
  }
  return output;
}

function parseEstimate(value: unknown): UsageEstimate {
  if (value === undefined) {
    return {
      fiveHourPercent: 0,
      weeklyPercent: 0,
      basis: 'none',
      uncertaintyPercent: 1,
      detail: 'No estimate supplied by the MCP caller; admission will wait for a defensible bound.',
    };
  }
  const input = assertRecord(value, 'estimate');
  assertAllowedKeys(input, ['fiveHourPercent', 'weeklyPercent', 'basis', 'uncertaintyPercent', 'detail'], 'estimate');
  const fiveHourPercent = requiredPercentage(input, 'fiveHourPercent');
  const weeklyPercent = requiredPercentage(input, 'weeklyPercent');
  const uncertaintyPercent = requiredPercentage(input, 'uncertaintyPercent');
  const basis = optionalEnum(input, 'basis', [...ESTIMATE_BASES]);
  if (basis === undefined) throw new ProtocolError(-32602, 'estimate.basis is required.');
  const detail = requiredString(input, 'detail', DISPATCH_LIMITS.detailLength);
  return { fiveHourPercent, weeklyPercent, uncertaintyPercent, basis: basis as UsageEstimate['basis'], detail };
}

function requiredPercentage(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new ProtocolError(-32602, `estimate.${key} must be a finite percentage from 0 through 100.`);
  }
  return value;
}

function parseCandidate(value: unknown): CandidateIdentity {
  const input = assertRecord(value, 'candidate');
  assertAllowedKeys(input, ['repo', 'base', 'head', 'artifacts', 'backendRevisions'], 'candidate');
  const candidate: CandidateIdentity = {
    repo: requiredString(input, 'repo', DISPATCH_LIMITS.identifierLength),
    base: requiredString(input, 'base', DISPATCH_LIMITS.identifierLength),
    head: requiredString(input, 'head', DISPATCH_LIMITS.identifierLength),
  };
  for (const key of ['artifacts', 'backendRevisions'] as const) {
    const valueMap = input[key];
    if (valueMap === undefined) continue;
    const record = assertRecord(valueMap, `candidate.${key}`);
    const parsed: Record<string, string> = {};
    for (const [name, value] of Object.entries(record)) {
      if (name.length > 256 || typeof value !== 'string' || value.length > 256) {
        throw new ProtocolError(-32602, `candidate.${key} must map short names to short strings.`);
      }
      parsed[name] = value;
    }
    candidate[key] = parsed;
  }
  return candidate;
}

function parseEvidenceItems(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value) || value.length > 1000) throw new ProtocolError(-32602, 'evidence must be an array of at most 1000 items.');
  return value.map((raw, index) => {
    const input = assertRecord(raw, `evidence[${index}]`);
    assertAllowedKeys(input, ['check', 'class', 'reportedOutcome', 'candidate', 'settings', 'fixtureVersion', 'observedAt', 'attempt', 'inaccessible', 'source'], `evidence[${index}]`);
    const evidence: EvidenceItem = {
      check: requiredString(input, 'check', 256),
      class: requiredEvidenceClass(input['class']),
      reportedOutcome: requiredOutcome(input['reportedOutcome']),
      candidate: parseCandidate(input['candidate']),
      observedAt: requiredString(input, 'observedAt', 128),
      source: requiredString(input, 'source', 4096),
    };
    const fixtureVersion = optionalString(input, 'fixtureVersion', 256);
    if (fixtureVersion !== undefined) evidence.fixtureVersion = fixtureVersion;
    const attempt = optionalNumber(input, 'attempt', 1, 1000);
    if (attempt !== undefined) evidence.attempt = attempt;
    if (input['inaccessible'] !== undefined) {
      if (typeof input['inaccessible'] !== 'boolean') throw new ProtocolError(-32602, `evidence[${index}].inaccessible must be boolean.`);
      evidence.inaccessible = input['inaccessible'];
    }
    if (input['settings'] !== undefined) evidence.settings = parseSettingsSnapshot(input['settings']);
    return evidence;
  });
}

function requiredEvidenceClass(value: unknown): EvidenceItem['class'] {
  const values = ['real-provider', 'native', 'emulator', 'mocked', 'judgment'] as const;
  if (typeof value !== 'string' || !values.includes(value as typeof values[number])) throw new ProtocolError(-32602, `evidence.class must be one of: ${values.join(', ')}.`);
  return value as EvidenceItem['class'];
}

function requiredOutcome(value: unknown): EvidenceItem['reportedOutcome'] {
  const values = ['passed', 'failed', 'skipped', 'errored'] as const;
  if (typeof value !== 'string' || !values.includes(value as typeof values[number])) throw new ProtocolError(-32602, `evidence.reportedOutcome must be one of: ${values.join(', ')}.`);
  return value as EvidenceItem['reportedOutcome'];
}

function parseSettingsSnapshot(value: unknown): SettingsSnapshot {
  const input = assertRecord(value, 'evidence.settings');
  assertAllowedKeys(input, ['requested', 'resolved', 'observed', 'substitution'], 'evidence.settings');
  const requested = parseSettingPair(input['requested'], 'requested', 'vendor-default');
  const resolved = parseSettingPair(input['resolved'], 'resolved', 'vendor-default');
  const observed = parseSettingPair(input['observed'], 'observed', 'unknown');
  const substitution = optionalString(input, 'substitution', 512);
  return {
    requested: { model: requested.model as string | 'vendor-default', effort: requested.effort as string | 'vendor-default' },
    resolved: { model: resolved.model as string | 'vendor-default', effort: resolved.effort as string | 'vendor-default' },
    observed: { model: observed.model as string | 'unknown', effort: observed.effort as string | 'unknown' },
    ...(substitution !== undefined ? { substitution } : {}),
  };
}

function parseSettingPair(value: unknown, key: string, fallback: string): { model: string; effort: string } {
  const input = assertRecord(value, `evidence.settings.${key}`);
  return {
    model: typeof input['model'] === 'string' ? input['model'] : fallback,
    effort: typeof input['effort'] === 'string' ? input['effort'] : fallback,
  };
}

function isRpcId(value: unknown): value is string | number | null {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 1000);
}

/** Run the server on strict LF-delimited JSONL stdin/stdout. */
export async function serveStdio(
  commandLayer: CoordinatorCommands = commands,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const server = new McpServer(commandLayer);
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let chain = Promise.resolve();
  const write = (response: JsonRpcResponse): void => {
    output.write(`${JSON.stringify(response)}\n`);
  };
  const handleLine = (line: string): void => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (text.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      write(rpcError(null, -32700, `Parse error: ${safeErrorMessage(error)}`));
      return;
    }
    chain = chain.then(async () => {
      const response = await server.handle(parsed);
      if (response !== undefined) write(response);
    }).catch((error: unknown) => {
      // The per-request handler already converts expected errors. This final guard
      // keeps one unexpected request from taking down the long-lived stdio server.
      write(rpcError(null, -32603, safeErrorMessage(error)));
    });
  };

  await new Promise<void>((resolveInput) => {
    input.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
    });
    input.on('end', () => {
      buffer += decoder.end();
      if (buffer.length > 0) handleLine(buffer);
      void chain.then(() => resolveInput());
    });
    input.on('error', (error) => {
      console.error(`MCP stdin error: ${safeErrorMessage(error)}`);
      void chain.then(() => resolveInput());
    });
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  serveStdio().catch((error: unknown) => {
    console.error(`MCP server stopped: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}

