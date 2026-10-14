#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';

import {
  commands as defaultCommands,
  configPath,
  DISPATCH_LIMITS,
  ESTIMATE_BASES,
  RUNTIMES,
  VALID_ACTIONS,
  type CoordinatorCommands,
  type DispatchCommandResult,
  type DispatchTaskInput,
  type EvaluationViewName,
} from '../commands.js';
import type { ConsoleCommands } from '../console/commands.js';
import type { PolicyChange } from '../console/steer.js';
import { STAGES } from '../loop/types.js';

const HOST = '127.0.0.1';
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const TEXT_CONTENT_TYPES = new Set(['.json', '.jsonl', '.log', '.txt', '.md', '.csv']);
type RuntimeId = (typeof RUNTIMES)[number];
type ActionId = (typeof VALID_ACTIONS)[number];
type UsageEstimate = DispatchTaskInput['estimate'];
type SettingsRequest = DispatchTaskInput['settings'];

export interface UiServerOptions {
  /** Trusted startup configuration. Defaults to the current working directory. */
  repoRoots?: string[];
  /** Injected in tests; production uses the shared command singleton. */
  commands?: CoordinatorCommands;
  port?: number;
  sessionTtlMs?: number;
  /** Trusted build asset directory. Defaults to dist/ui/public beside this module. */
  staticDir?: string;
  /** Test-only static override. */
  staticFiles?: Partial<Record<'/' | '/index.html' | '/app.js' | '/styles.css', string>>;
  /** The operator console over one target store, named at startup; absent, the console routes say how to start it. */
  console?: ConsoleCommands;
}

export interface UiServerHandle {
  server: Server;
  port: number;
  bootstrapToken: string;
  url: string;
  close(): Promise<void>;
}

interface Session {
  id: string;
  csrf: string;
  operator?: string;
  createdAt: number;
  expiresAt: number;
}

interface Operation {
  id: string;
  kind: 'dispatch' | 'recover';
  startedAt: string;
  state: 'running' | 'completed' | 'failed';
  taskId?: string;
  result?: unknown;
  error?: string;
}

interface JsonObject {
  [key: string]: unknown;
}

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  session?: Session;
}

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServerHandle> {
  const port = validatePort(options.port ?? 0);
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const bootstrapToken = randomToken();
  const sessions = new Map<string, Session>();
  const operations = new Map<string, Operation>();
  let bootstrapUsed = false;
  let boundPort = port;

  const commands = options.commands ?? defaultCommands;
  const operator = commands.configuredOperator();
  const repoRoots = await resolveRepoRoots(options.repoRoots);
  const staticDir = options.staticDir ?? join(dirname(fileURLToPath(import.meta.url)), 'public');
  const staticFiles = await loadStaticFiles(staticDir, options.staticFiles);

  const server = createServer((req, res) => {
    void handleRequest({ req, res, url: parseRequestUrl(req, boundPort) }, {
      commands,
      ...(options.console ? { console: options.console } : {}),
      operator,
      repoRoots,
      sessions,
      operations,
      staticFiles,
      bootstrapToken,
      getBootstrapUsed: () => bootstrapUsed,
      consumeBootstrap: () => { bootstrapUsed = true; },
      sessionTtlMs,
      port: () => boundPort,
    }).catch((err: unknown) => {
      if (!res.headersSent) {
        if (err instanceof HttpError) sendError(res, err.status, err.code, err.message);
        else sendError(res, 500, 'server-error', 'The UI server could not complete the request.');
      } else res.destroy();
      if (!(err instanceof HttpError)) console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    });
  });

  server.listen({ host: HOST, port });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The UI server did not expose a TCP address.');
  boundPort = address.port;

  const url = `http://${HOST}:${boundPort}/#bootstrap=${bootstrapToken}`;
  return {
    server,
    port: boundPort,
    bootstrapToken,
    url,
    close: async () => {
      for (const session of sessions.values()) sessions.delete(session.id);
      await new Promise<void>((resolveClose, reject) => {
        server.close((err) => err ? reject(err) : resolveClose());
      });
    },
  };
}

interface HandlerOptions {
  commands: CoordinatorCommands;
  console?: ConsoleCommands;
  operator: string | undefined;
  repoRoots: string[];
  sessions: Map<string, Session>;
  operations: Map<string, Operation>;
  staticFiles: Record<string, { body: string; type: string }>;
  bootstrapToken: string;
  getBootstrapUsed(): boolean;
  consumeBootstrap(): void;
  sessionTtlMs: number;
  port(): number;
}

async function handleRequest(ctx: RequestContext, options: HandlerOptions): Promise<void> {
  setSecurityHeaders(ctx.res);

  if (ctx.url.pathname === '/api/session/bootstrap' && ctx.req.method === 'POST') {
    await bootstrap(ctx, options);
    return;
  }

  const staticFile = options.staticFiles[ctx.url.pathname];
  if (ctx.req.method === 'GET' && staticFile !== undefined) {
    sendText(ctx.res, 200, staticFile.type, staticFile.body, true);
    return;
  }

  if (!ctx.url.pathname.startsWith('/api/')) {
    sendError(ctx.res, 404, 'not-found', 'No such UI route.');
    return;
  }

  assertHost(ctx.req, options.port());
  const session = authenticate(ctx.req, options.sessions);
  ctx.session = session;
  if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') {
    assertSameOrigin(ctx.req, options.port());
    assertCsrf(ctx.req, session);
  }

  if (ctx.url.pathname === '/api/session' && ctx.req.method === 'GET') {
    sendJson(ctx.res, 200, {
      operator: session.operator ?? null,
      expiresAt: new Date(session.expiresAt).toISOString(),
      csrfToken: session.csrf,
    });
    return;
  }

  if (ctx.url.pathname === '/api/overview' && ctx.req.method === 'GET') {
    await overview(ctx, options);
    return;
  }
  if (ctx.url.pathname === '/api/status' && ctx.req.method === 'GET') {
    sendJson(ctx.res, 200, options.commands.status(optionalQuery(ctx.url, 'taskId') ? { taskId: ctx.url.searchParams.get('taskId')! } : {}));
    return;
  }
  if (ctx.url.pathname === '/api/jobs' && ctx.req.method === 'GET') {
    sendJson(ctx.res, 200, options.commands.jobs());
    return;
  }
  if (ctx.url.pathname === '/api/runtimes/usage' && ctx.req.method === 'GET') {
    const runtime = optionalRuntime(ctx.url.searchParams.get('runtime'));
    sendJson(ctx.res, 200, await options.commands.usage(runtime ? { runtime } : {}));
    return;
  }
  if (ctx.url.pathname === '/api/runtimes/readiness' && ctx.req.method === 'GET') {
    const runtime = optionalRuntime(ctx.url.searchParams.get('runtime'));
    sendJson(ctx.res, 200, await options.commands.readiness(runtime ? { runtime } : {}));
    return;
  }
  if (ctx.url.pathname === '/api/evidence' && ctx.req.method === 'GET') {
    sendJson(ctx.res, 200, options.commands.evidence());
    return;
  }
  if (ctx.url.pathname === '/api/evaluation' && ctx.req.method === 'GET') {
    sendJson(ctx.res, 200, options.commands.evaluation(parseEvaluationInput(ctx.url.searchParams)));
    return;
  }
  if (ctx.url.pathname === '/api/authority' && ctx.req.method === 'GET') {
    sendJson(ctx.res, 200, options.commands.authority());
    return;
  }
  if (ctx.url.pathname === '/api/ledger' && ctx.req.method === 'GET') {
    sendJson(ctx.res, 200, options.commands.ledger());
    return;
  }
  if (ctx.url.pathname === '/api/versions' && ctx.req.method === 'GET') {
    sendJson(ctx.res, 200, options.commands.version());
    return;
  }
  if (ctx.url.pathname.startsWith('/api/console/') && ctx.req.method === 'GET') {
    await consoleRead(ctx, options);
    return;
  }
  if (ctx.url.pathname === '/api/operations' && ctx.req.method === 'GET') {
    sendJson(ctx.res, 200, { operations: [...options.operations.values()].map(publicOperation) });
    return;
  }

  const evidenceMatch = /^\/api\/evidence\/runs\/([^/]+)(?:\/(.*))?$/.exec(ctx.url.pathname);
  if (evidenceMatch && ctx.req.method === 'GET') {
    await evidenceRoute(ctx, evidenceMatch[1]!, evidenceMatch[2], options);
    return;
  }
  const operationMatch = /^\/api\/operations\/([^/]+)$/.exec(ctx.url.pathname);
  if (operationMatch && ctx.req.method === 'GET') {
    const operation = options.operations.get(operationMatch[1]!);
    if (!operation) return sendError(ctx.res, 404, 'not-found', 'No UI operation with that id.');
    sendJson(ctx.res, 200, publicOperation(operation));
    return;
  }

  if (ctx.req.method === 'POST') {
    await mutationRoute(ctx, options);
    return;
  }

  sendError(ctx.res, 405, 'method-not-allowed', 'Use the method shown by the UI route.');
}

async function bootstrap(ctx: RequestContext, options: HandlerOptions): Promise<void> {
  assertHost(ctx.req, options.port());
  if (options.getBootstrapUsed()) return sendError(ctx.res, 401, 'bootstrap-used', 'The bootstrap link has already been used. Start a new UI server.');
  const supplied = ctx.req.headers['x-ui-bootstrap'];
  if (typeof supplied !== 'string' || !safeEqual(supplied, options.bootstrapToken)) {
    return sendError(ctx.res, 401, 'bootstrap-invalid', 'The bootstrap token is invalid. Use the URL printed by the UI server.');
  }
  options.consumeBootstrap();
  const now = Date.now();
  const session: Session = {
    id: randomToken(),
    csrf: randomToken(),
    ...(options.operator ? { operator: options.operator } : {}),
    createdAt: now,
    expiresAt: now + options.sessionTtlMs,
  };
  options.sessions.set(session.id, session);
  sendJson(ctx.res, 200, {
    operator: session.operator ?? null,
    csrfToken: session.csrf,
    expiresAt: new Date(session.expiresAt).toISOString(),
  }, { 'Set-Cookie': `ui_session=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(options.sessionTtlMs / 1000)}` });
}

async function overview(ctx: RequestContext, options: HandlerOptions): Promise<void> {
  const status = options.commands.status();
  const jobs = options.commands.jobs();
  const [evaluation, evidence, authority, version, ledger] = await Promise.all([
    Promise.resolve(options.commands.evaluation({ view: 'summary' })),
    Promise.resolve(options.commands.evidence()),
    Promise.resolve(options.commands.authority()),
    Promise.resolve(options.commands.version()),
    Promise.resolve(options.commands.ledger()),
  ]);
  sendJson(ctx.res, 200, {
    generatedAt: new Date().toISOString(),
    operator: options.operator ?? null,
    status,
    jobs,
    readiness: null,
    usage: null,
    evaluation,
    evidence,
    version,
    authority,
    ledger,
  });
}

async function consoleRead(ctx: RequestContext, options: HandlerOptions): Promise<void> {
  const target = requireConsole(options);
  const path = ctx.url.pathname;
  if (path === '/api/console/view') return sendJson(ctx.res, 200, await target.view());
  if (path === '/api/console/steer') return sendJson(ctx.res, 200, await target.steer());
  if (path === '/api/console/inspect') {
    const ref = itemRef(ctx.url.searchParams.get('ref'));
    try {
      return sendJson(ctx.res, 200, await target.inspect(ref));
    } catch (err) {
      throw new HttpError(404, 'not-found', err instanceof Error ? err.message : String(err));
    }
  }
  throw new HttpError(404, 'not-found', 'No such console view.');
}

function requireConsole(options: HandlerOptions): ConsoleCommands {
  if (!options.console) throw new HttpError(404, 'console-not-configured', 'The console needs a target store: start the UI with `agentsys ui --repo <path>`.');
  return options.console;
}

/** Console writes: the browser names an item or a stage or a run, never who acts or where. */
async function consoleMutation(ctx: RequestContext, options: HandlerOptions, body: JsonObject, actor: OperatorActor): Promise<boolean> {
  const path = ctx.url.pathname;
  if (!path.startsWith('/api/console/')) return false;
  const target = requireConsole(options);
  for (const key of ['repo', 'repoPath', 'path', 'target']) {
    if (key in body) throw new HttpError(400, 'target-not-accepted', 'The console acts on the store it was started for; the browser cannot name another.');
  }
  if (path === '/api/console/actions') {
    const input = consoleActionInput(body);
    await sendMutation(ctx.res, () => target.act(actor, input));
    return true;
  }
  if (path === '/api/console/policy') {
    const change = policyChangeInput(body);
    await sendMutation(ctx.res, () => target.propose(actor, change));
    return true;
  }
  if (path === '/api/console/cases') {
    const input = freezeCaseInput(body);
    await sendMutation(ctx.res, () => target.freezeCase(actor, input));
    return true;
  }
  const stageMatch = /^\/api\/console\/stages\/([a-z]+)\/(pause|resume)$/.exec(path);
  if (stageMatch) {
    if (!STAGES.some((s) => s.name === stageMatch[1])) throw new HttpError(422, 'invalid-stage', 'No such stage.');
    await sendMutation(ctx.res, () => target.pause(actor, stageMatch[1]!, stageMatch[2] === 'pause'));
    return true;
  }
  const runMatch = /^\/api\/console\/runs\/(run_[a-z0-9]+)\/(stop|redispatch)$/.exec(path);
  if (runMatch) {
    const runId = runMatch[1]!;
    if (runMatch[2] === 'stop') {
      await sendMutation(ctx.res, () => target.stopRun(actor, runId));
      return true;
    }
    const operation = startOperation(options.operations, 'dispatch', undefined, () => target.redispatchRun(actor, runId));
    sendJson(ctx.res, 202, publicOperation(operation));
    return true;
  }
  throw new HttpError(404, 'not-found', 'No such console action.');
}

const ACTIONS = ['apply-shaped', 'apply-auto', 'merge', 'close-not-planned', 'close-completed', 'release-claim', 'dismiss-fault', 'answer-escalation', 'open'] as const;

function itemRef(value: string | null | undefined): string {
  if (typeof value !== 'string' || !/^(?:PR )?#\d{1,7}$/.test(value)) throw new HttpError(422, 'invalid-ref', 'ref must be #<n> or PR #<n>.');
  return value;
}

function consoleActionInput(body: JsonObject): Parameters<ConsoleCommands['act']>[1] {
  const action = requiredText(body, 'action', 64);
  if (!(ACTIONS as readonly string[]).includes(action)) throw new HttpError(422, 'invalid-action', 'action is not a console action.');
  const verdictBody = body.verdict;
  let verdict: { cardId: string; verdict: 'accepted' | 'rework-needed' | 'rejected'; reason: string } | undefined;
  if (verdictBody !== undefined && verdictBody !== null) {
    if (!isObject(verdictBody)) throw new HttpError(422, 'invalid-verdict', 'verdict must be an object.');
    const cardId = requiredText(verdictBody, 'cardId', 256);
    if (!/^card_[\w.-]+$/.test(cardId)) throw new HttpError(422, 'invalid-scorecard', 'scorecard id is invalid.');
    verdict = { cardId, ...feedbackInput(verdictBody) };
  }
  return {
    ref: itemRef(valueString(body, 'ref')),
    action: action as (typeof ACTIONS)[number],
    expected: requiredFingerprint(body, 'expected'),
    ...(body.text !== undefined ? { text: requiredText(body, 'text', 20_000) } : {}),
    ...(verdict ? { verdict } : {}),
  };
}

const CASE_KINDS = ['reviewer-detects-bad-candidate', 'approved-repair', 'approved-feature', 'refusal-or-pending'] as const;

function freezeCaseInput(body: JsonObject): Parameters<ConsoleCommands['freezeCase']>[1] {
  const kind = requiredText(body, 'kind', 64);
  if (!(CASE_KINDS as readonly string[]).includes(kind)) throw new HttpError(422, 'invalid-kind', 'kind is not one of the oracle\'s case kinds.');
  return {
    ref: itemRef(valueString(body, 'ref')),
    kind: kind as (typeof CASE_KINDS)[number],
    expected: requiredText(body, 'expected', 64),
    words: requiredText(body, 'words', 4_000),
    ...(body.defectPattern !== undefined ? { defectPattern: requiredText(body, 'defectPattern', 200) } : {}),
    ...(body.runId !== undefined ? { runId: safeId(requiredText(body, 'runId', 256), /^run_[a-z0-9]+$/) } : {}),
  };
}

function policyChangeInput(body: JsonObject): PolicyChange {
  const kind = requiredText(body, 'kind', 16);
  const cell = (key: string, max: number): string => {
    const value = requiredText(body, key, max);
    if (/[|\n\r`]/.test(value)) throw new HttpError(422, 'invalid-cell', `${key} cannot contain a table delimiter, a backtick or a line break.`);
    return value.trim();
  };
  if (kind === 'stop-line') {
    const label = cell('label', 128);
    if (label !== 'default' && !/^type:[\w.-]+$/.test(label)) throw new HttpError(422, 'invalid-label', 'label must be default or type:<slug>.');
    return { kind, label, value: boundedNumber(body.value, 'value', 0, 20) };
  }
  if (kind === 'tier') {
    return {
      kind, stage: cell('stage', 64), runtime: requiredRuntime(body, 'runtime'), model: cell('model', 128), effort: cell('effort', 64),
      fiveHourPercent: boundedNumber(body.fiveHourPercent, 'fiveHourPercent', 0, 100), weeklyPercent: boundedNumber(body.weeklyPercent, 'weeklyPercent', 0, 100),
    };
  }
  if (kind === 'limit') return { kind, setting: cell('setting', 128), value: cell('value', 500) };
  throw new HttpError(422, 'invalid-change', 'kind must be stop-line, tier or limit.');
}

async function mutationRoute(ctx: RequestContext, options: HandlerOptions): Promise<void> {
  const body = await readJsonBody(ctx.req);
  if ('as' in body || 'actor' in body || 'operator' in body) throw new HttpError(400, 'actor-not-accepted', 'The browser cannot select an operator or actor.');
  const path = ctx.url.pathname;

  if (path === '/api/dispatch') {
    const input = await parseDispatchInput(body, options.repoRoots);
    const operation = startOperation(options.operations, 'dispatch', input.taskId, () => options.commands.dispatch(input));
    sendJson(ctx.res, 202, publicOperation(operation));
    return;
  }
  if (path === '/api/recover') {
    const runtime = optionalRuntime(valueString(body, 'runtime'));
    if (valueString(body, 'runtime') !== undefined && runtime === undefined) throw new HttpError(422, 'invalid-runtime', 'runtime is not supported.');
    const operation = startOperation(options.operations, 'recover', undefined, () => options.commands.recover(runtime));
    sendJson(ctx.res, 202, publicOperation(operation));
    return;
  }
  if (path === '/api/intake') {
    const input = intakeInput(body);
    return sendMutation(ctx.res, () => options.commands.intakeFailure(input.event, input.config));
  }

  const actor = operatorActor(ctx.session!, options.operator, options.commands);
  if (await consoleMutation(ctx, options, body, actor)) return;
  if (path === '/api/approvals') {
    return sendMutation(ctx.res, () => options.commands.approve(actor, approvalInput(body)));
  }
  if (path === '/api/grants') {
    return sendMutation(ctx.res, () => options.commands.grantCreate(actor, grantInput(body)));
  }
  const grantMatch = /^\/api\/grants\/([^/]+)\/(narrow|revoke)$/.exec(path);
  if (grantMatch) {
    if (grantMatch[2] === 'narrow') return sendMutation(ctx.res, () => options.commands.grantNarrow(actor, safeId(grantMatch[1]!, /^grant_[a-z0-9]+$/), narrowInput(body)));
    return sendMutation(ctx.res, () => options.commands.grantRevoke(actor, safeId(grantMatch[1]!, /^grant_[a-z0-9]+$/), requiredText(body, 'reason', 4_000)));
  }
  if (path.startsWith('/api/policies/')) {
    const subscription = decodeURIComponent(path.slice('/api/policies/'.length));
    if (!subscription || !/^[\w.-]{1,128}$/.test(subscription)) throw new HttpError(422, 'invalid-subscription', 'subscription is invalid.');
    const current = options.commands.policy(subscription).policy;
    return sendMutation(ctx.res, () => options.commands.policySet(actor, policyInput(subscription, body, current)));
  }
  if (path === '/api/ledger/policy') {
    return sendMutation(ctx.res, () => options.commands.ledgerAllowanceSet(actor, boundedNumber(body.allowanceUsd, 'allowanceUsd', Number.MIN_VALUE, 1_000_000)));
  }
  if (path.startsWith('/api/scorecards/') && path.endsWith('/feedback')) {
    const id = path.slice('/api/scorecards/'.length, -'/feedback'.length);
    if (!/^card_[\w.-]+$/.test(id)) throw new HttpError(422, 'invalid-scorecard', 'scorecard id is invalid.');
    return sendMutation(ctx.res, () => options.commands.feedbackRecord(actor, id, feedbackInput(body)));
  }
  const checkMatch = /^\/api\/checks\/([^/]+)\/(defer|restore)$/.exec(path);
  if (checkMatch) {
    const name = safeId(checkMatch[1]!, /^[\w.-]{1,256}$/);
    return checkMatch[2] === 'defer'
      ? sendMutation(ctx.res, () => options.commands.checkDefer(actor, name, requiredText(body, 'reason', 4_000)))
      : sendMutation(ctx.res, () => options.commands.checkRestore(actor, name));
  }
  if (path === '/api/versions/activate') {
    return sendMutation(ctx.res, () => options.commands.versionActivate(actor, versionActivateInput(body)));
  }
  if (path === '/api/versions/rollback') {
    return sendMutation(ctx.res, () => options.commands.versionRollback(actor));
  }

  throw new HttpError(404, 'not-found', 'No such UI mutation route.');
}

async function sendMutation<T>(res: ServerResponse, action: () => T | Promise<T>): Promise<void> {
  try {
    sendJson(res, 200, { ok: true, data: await action() });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(409, 'mutation-refused', err instanceof Error ? err.message : String(err));
  }
}

async function evidenceRoute(
  ctx: RequestContext,
  runId: string,
  relativeName: string | undefined,
  _options: HandlerOptions,
): Promise<void> {
  if (!/^run_[a-z0-9]+$/.test(runId)) throw new HttpError(422, 'invalid-run', 'run id is invalid.');
  const run = _options.commands.status().runs.find((entry) => entry.run.id === runId)?.run;
  if (!run) throw new HttpError(404, 'not-found', 'No such run.');
  const root = resolve(dirname(configPath()), 'evidence', runId);
  const rootReal = await safeRealpath(root);
  if (!rootReal) return sendJson(ctx.res, 200, { runId, files: [] });
  if (relativeName === undefined || relativeName === '') {
    const entries = await readdir(rootReal, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !safeEvidenceName(entry.name)) continue;
      const filePath = join(rootReal, entry.name);
      const info = await lstat(filePath);
      if (info.isSymbolicLink()) continue;
      files.push({ name: entry.name, bytes: info.size, url: `/api/evidence/runs/${runId}/${encodeURIComponent(entry.name)}` });
    }
    return sendJson(ctx.res, 200, { runId, files });
  }
  if (relativeName.includes('/') || relativeName.includes('\\') || relativeName !== decodeURIComponent(relativeName)) {
    throw new HttpError(400, 'invalid-evidence-path', 'Evidence paths must name one file in the run directory.');
  }
  const name = decodeURIComponent(relativeName);
  if (!safeEvidenceName(name)) throw new HttpError(400, 'invalid-evidence-path', 'That evidence file type is not viewable.');
  const filePath = join(rootReal, name);
  const fileReal = await safeRealpath(filePath);
  if (!fileReal || !isWithin(rootReal, fileReal)) throw new HttpError(404, 'not-found', 'No such evidence file.');
  const info = await lstat(fileReal);
  if (!info.isFile() || info.size > MAX_EVIDENCE_BYTES) throw new HttpError(413, 'evidence-too-large', 'This evidence file is too large to display.');
  const body = await readFile(fileReal, 'utf8');
  sendText(ctx.res, 200, 'text/plain; charset=utf-8', body, false);
}

function startOperation<T>(operations: Map<string, Operation>, kind: Operation['kind'], taskId: string | undefined, work: () => Promise<T>): Operation {
  const operation: Operation = {
    id: `op_${randomToken().slice(0, 16)}`,
    kind,
    startedAt: new Date().toISOString(),
    state: 'running',
    ...(taskId ? { taskId } : {}),
  };
  operations.set(operation.id, operation);
  void work().then((result) => {
    operation.state = 'completed';
    operation.result = publicOperationResult(result);
  }).catch((err: unknown) => {
    operation.state = 'failed';
    operation.error = err instanceof Error ? err.message : String(err);
  });
  return operation;
}

function publicOperation(operation: Operation): JsonObject {
  return {
    id: operation.id,
    kind: operation.kind,
    startedAt: operation.startedAt,
    state: operation.state,
    ...(operation.taskId ? { taskId: operation.taskId } : {}),
    ...(operation.state === 'completed' ? { result: operation.result } : {}),
    ...(operation.error ? { error: operation.error } : {}),
  };
}

function publicOperationResult(result: unknown): unknown {
  if (isDispatchResult(result)) {
    return {
      outcome: result.outcome,
      ...('runtimeDispatched' in result && typeof result.runtimeDispatched === 'boolean' ? { runtimeDispatched: result.runtimeDispatched } : {}),
      recovered: result.recovered.map((report) => ({ runId: report.runId, before: report.before, outcome: report.outcome, blocksNewAttempt: report.blocksNewAttempt })),
      ...(result.authority ? { authority: result.authority } : {}),
      ...(result.limits ? { limits: result.limits } : {}),
      ...(result.admission ? { admission: result.admission } : {}),
      ...(result.run ? { run: publicRun(result.run) } : {}),
    };
  }
  if (Array.isArray(result)) return result;
  return result;
}

function isDispatchResult(value: unknown): value is DispatchCommandResult {
  return typeof value === 'object' && value !== null && 'outcome' in value && 'recovered' in value;
}

function publicRun(run: unknown): unknown {
  if (!isObject(run)) return null;
  return {
    id: run.id,
    taskId: run.taskId,
    attempt: run.attempt,
    authority: run.authority,
    limits: run.limits,
    runtime: run.runtime,
    profile: run.profile,
    actions: run.actions,
    settings: run.settings,
    sessionId: run.sessionId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    status: run.status,
    summary: run.summary,
    build: run.build ?? null,
    runtimeDispatched: run.runtimeDispatched,
    delivery: run.delivery,
    timing: run.timing,
    outputPath: run.outputPath,
    evidenceUrl: `/api/evidence/runs/${run.id}`,
  };
}

type OperatorActor = Parameters<CoordinatorCommands['approve']>[0];
type ApprovalInput = Parameters<CoordinatorCommands['approve']>[1];
type GrantInput = Parameters<CoordinatorCommands['grantCreate']>[1];
type NarrowInput = Parameters<CoordinatorCommands['grantNarrow']>[2];
type PolicyInput = Parameters<CoordinatorCommands['policySet']>[1];
type FeedbackInput = Parameters<CoordinatorCommands['feedbackRecord']>[2];
type VersionActivateInput = Parameters<CoordinatorCommands['versionActivate']>[1];
type IntakeEvent = Parameters<CoordinatorCommands['intakeFailure']>[0];
type IntakeConfig = Parameters<CoordinatorCommands['intakeFailure']>[1];

function operatorActor(session: Session, startupOperator: string | undefined, commands: CoordinatorCommands): OperatorActor {
  ensureCurrentOperator(session, startupOperator, commands);
  return { kind: 'operator', id: session.operator } as OperatorActor;
}

function approvalInput(body: JsonObject): ApprovalInput {
  return {
    repo: requiredText(body, 'repo', 256),
    taskScope: requiredText(body, 'scope', 4_000),
    workClass: requiredText(body, 'workClass', 256),
    runtime: requiredRuntime(body, 'runtime'),
    profile: requiredText(body, 'profile', 256),
    actions: actionList(body, 'actions'),
    limits: {
      maxAttempts: boundedNumber(body.maxAttempts ?? 3, 'maxAttempts', 1, 100),
      maxConcurrentRuns: boundedNumber(body.maxConcurrentRuns ?? 1, 'maxConcurrentRuns', 1, 100),
      maxPaidCallUsd: boundedNumber(body.maxPaidCallUsd ?? 1, 'maxPaidCallUsd', Number.MIN_VALUE, 1_000_000),
    },
    // The approved tier. Omitted means the operator named none, which is what
    // every approval written before this field existed says.
    ...(body.model === undefined ? {} : { model: requiredText(body, 'model', 256) }),
    ...(body.effort === undefined ? {} : { effort: requiredText(body, 'effort', 64) }),
  };
}

function grantInput(body: JsonObject): GrantInput {
  return {
    repos: stringList(body, 'repos'),
    workClasses: stringList(body, 'workClasses'),
    triggerSources: stringList(body, 'triggerSources'),
    actions: actionList(body, 'actions'),
    runtimes: runtimeList(body.runtimes),
    profiles: stringList(body, 'profiles'),
    perTask: {
      maxAttempts: boundedNumber(body.maxAttempts ?? 3, 'maxAttempts', 1, 100),
      maxConcurrentRuns: boundedNumber(body.maxConcurrentRuns ?? 1, 'maxConcurrentRuns', 1, 100),
      maxPaidCallUsd: boundedNumber(body.maxPaidCallUsd ?? 1, 'maxPaidCallUsd', Number.MIN_VALUE, 1_000_000),
    },
    aggregate: {
      maxDispatchesPerWindow: boundedNumber(body.maxDispatchesPerWindow, 'maxDispatchesPerWindow', 1, 1_000_000),
      windowHours: boundedNumber(body.windowHours ?? 24, 'windowHours', Number.MIN_VALUE, 24 * 365),
      maxConcurrentRuns: boundedNumber(body.maxAggregateConcurrentRuns ?? 1, 'maxAggregateConcurrentRuns', 1, 100),
    },
    reason: requiredText(body, 'reason', 4_000),
  };
}

function narrowInput(body: JsonObject): NarrowInput {
  const input: NarrowInput = { reason: requiredText(body, 'reason', 4_000) };
  for (const field of ['repos', 'workClasses', 'triggerSources', 'profiles'] as const) {
    if (body[field] !== undefined) input[field] = stringList(body, field);
  }
  if (body.actions !== undefined) input.actions = actionList(body, 'actions');
  if (body.runtimes !== undefined) input.runtimes = runtimeList(body.runtimes);
  if (body.maxDispatchesPerWindow !== undefined) input.aggregate = { maxDispatchesPerWindow: boundedNumber(body.maxDispatchesPerWindow, 'maxDispatchesPerWindow', 1, 1_000_000) };
  return input;
}

function policyInput(subscriptionId: string, body: JsonObject, current?: PolicyInput): PolicyInput {
  return {
    subscriptionId,
    fiveHourThresholdPercent: boundedNumber(body.fiveHourThresholdPercent, 'fiveHourThresholdPercent', 0, 100),
    weeklyThresholdPercent: boundedNumber(body.weeklyThresholdPercent, 'weeklyThresholdPercent', 0, 100),
    safetyMarginPercent: boundedNumber(body.safetyMarginPercent, 'safetyMarginPercent', 0, 100),
    maxReadingAgeSeconds: boundedNumber(body.maxReadingAgeSeconds, 'maxReadingAgeSeconds', 0, 86_400),
    applicableWindows: body.applicableWindows === undefined ? current?.applicableWindows ?? ['five-hour', 'weekly'] : windowList(body.applicableWindows),
  };
}

function feedbackInput(body: JsonObject): FeedbackInput {
  const verdict = requiredText(body, 'verdict', 32);
  if (!['accepted', 'rework-needed', 'rejected'].includes(verdict)) throw new HttpError(422, 'invalid-verdict', 'verdict is invalid.');
  return { verdict: verdict as FeedbackInput['verdict'], reason: requiredText(body, 'reason', 4_000) };
}

function versionActivateInput(body: JsonObject): VersionActivateInput {
  const mergedPr = requiredText(body, 'mergedPr', 2_000);
  if (!/^https?:\/\//.test(mergedPr)) throw new HttpError(422, 'invalid-pr', 'mergedPr must be an HTTP(S) URL.');
  if (body.mergeConfirmed !== true) throw new HttpError(422, 'merge-not-confirmed', 'The reviewed merge must be explicitly confirmed.');
  const adapters = body.adapters === undefined ? {} : stringRecord(body.adapters, 'adapters');
  return { coordinator: requiredText(body, 'coordinator', 256), adapters, prompts: body.prompts === undefined ? 'unrecorded' : requiredText(body, 'prompts', 4_000), mergedPr, mergeConfirmed: true };
}

function intakeInput(body: JsonObject): { event: IntakeEvent; config: IntakeConfig } {
  if (!isObject(body.event)) throw new HttpError(422, 'invalid-event', 'event must be an object.');
  const event = body.event as unknown as IntakeEvent;
  return {
    event,
    config: {
      workClass: requiredText(body, 'workClass', 256),
      runtime: requiredRuntime(body, 'runtime'),
      profile: requiredText(body, 'profile', 256),
      actions: actionList(body, 'actions'),
      obligations: stringList(body, 'obligations'),
    },
  };
}

async function parseDispatchInput(body: JsonObject, repoRoots: string[]): Promise<DispatchTaskInput> {
  const actions = actionList(body, 'actions');
  const runtime = requiredRuntime(body, 'runtime');
  const estimateObject = body.estimate;
  if (!isObject(estimateObject)) throw new HttpError(422, 'invalid-estimate', 'estimate is required.');
  const estimate: UsageEstimate = {
    fiveHourPercent: boundedNumber(estimateObject.fiveHourPercent, 'estimate.fiveHourPercent', 0, 100),
    weeklyPercent: boundedNumber(estimateObject.weeklyPercent, 'estimate.weeklyPercent', 0, 100),
    uncertaintyPercent: boundedNumber(estimateObject.uncertaintyPercent, 'estimate.uncertaintyPercent', 0, 100),
    basis: requiredEstimateBasis(estimateObject.basis),
    detail: requiredText(estimateObject, 'detail', DISPATCH_LIMITS.detailLength),
  };
  const settingsObject = body.settings;
  if (!isObject(settingsObject)) throw new HttpError(422, 'invalid-settings', 'settings is required.');
  const settings: SettingsRequest = {
    ...(settingsObject.model === undefined ? {} : { model: requiredText(settingsObject, 'model', 256) }),
    ...(settingsObject.effort === undefined ? {} : { effort: requiredText(settingsObject, 'effort', 64) }),
    ...(settingsObject.acceptVendorDefault === true ? { acceptVendorDefault: true } : {}),
  };
  const repoPath = body.repoPath === undefined ? process.cwd() : requiredText(body, 'repoPath', 4_000);
  const safeRepoPath = await allowlistedPath(repoPath, repoRoots);
  const approvalId = optionalText(body, 'approvalId', DISPATCH_LIMITS.identifierLength);
  const triggerSource = optionalText(body, 'triggerSource', DISPATCH_LIMITS.identifierLength);
  const prBase = optionalText(body, 'prBase', DISPATCH_LIMITS.identifierLength);
  const targetProject = optionalText(body, 'targetProject', DISPATCH_LIMITS.identifierLength);
  const jobId = optionalText(body, 'jobId', DISPATCH_LIMITS.identifierLength);
  const input: DispatchTaskInput = {
    taskId: requiredText(body, 'taskId', DISPATCH_LIMITS.identifierLength),
    repo: requiredText(body, 'repo', DISPATCH_LIMITS.identifierLength),
    workClass: requiredText(body, 'workClass', DISPATCH_LIMITS.identifierLength),
    runtime,
    profile: requiredText(body, 'profile', DISPATCH_LIMITS.identifierLength),
    actions,
    prompt: requiredText(body, 'prompt', DISPATCH_LIMITS.promptLength),
    repoPath: safeRepoPath,
    settings,
    estimate,
    ...(approvalId !== undefined ? { approvalId } : {}),
    ...(triggerSource !== undefined ? { triggerSource } : {}),
    ...(prBase !== undefined ? { prBase } : {}),
    ...(targetProject !== undefined ? { targetProject } : {}),
    ...(jobId !== undefined ? { jobId } : {}),
    ...(body.timeoutMs === undefined ? {} : { timeoutMs: boundedNumber(body.timeoutMs, 'timeoutMs', 1_000, DISPATCH_LIMITS.maxTimeoutMs) }),
  };
  if (input.triggerSource !== undefined && input.jobId === undefined) throw new HttpError(422, 'trigger-needs-job', 'Grant-triggered browser dispatch must name an existing event job.');
  return input;
}

function parseEvaluationInput(params: URLSearchParams): { view?: EvaluationViewName; repo?: string; workClass?: string; runtime?: RuntimeId; authorityId?: string; effectiveConfiguration?: string; workflowVersion?: string; configurationA?: string; configurationB?: string } {
  const view = params.get('view');
  if (view !== null && !['summary', 'scorecards', 'suites', 'trials', 'compare'].includes(view)) throw new HttpError(422, 'invalid-evaluation-view', 'evaluation view is invalid.');
  const runtime = optionalRuntime(params.get('runtime'));
  if (params.get('runtime') !== null && runtime === undefined) throw new HttpError(422, 'invalid-runtime', 'runtime is invalid.');
  return {
    ...(view ? { view: view as EvaluationViewName } : {}),
    ...optionalParams(params, ['repo', 'workClass', 'authorityId', 'effectiveConfiguration', 'workflowVersion', 'configurationA', 'configurationB']),
    ...(runtime ? { runtime } : {}),
  };
}

function authenticate(req: IncomingMessage, sessions: Map<string, Session>): Session {
  const cookies = parseCookies(req.headers.cookie);
  const id = cookies.ui_session;
  const session = id ? sessions.get(id) : undefined;
  if (!session || session.expiresAt <= Date.now()) {
    if (id) sessions.delete(id);
    throw new HttpError(401, 'unauthenticated', 'Open the bootstrap URL printed by the UI server.');
  }
  return session;
}

function assertHost(req: IncomingMessage, port: number): void {
  if (req.headers.host !== `${HOST}:${port}`) throw new HttpError(403, 'invalid-host', 'The UI accepts only its loopback host.');
}

function assertSameOrigin(req: IncomingMessage, port: number): void {
  const origin = req.headers.origin;
  if (origin !== `http://${HOST}:${port}`) throw new HttpError(403, 'invalid-origin', 'The UI accepts mutations only from its own origin.');
}

function assertCsrf(req: IncomingMessage, session: Session): void {
  const value = req.headers['x-csrf-token'];
  if (typeof value !== 'string' || !safeEqual(value, session.csrf)) throw new HttpError(403, 'invalid-csrf', 'The request did not carry the session CSRF token.');
}

function ensureCurrentOperator(session: Session, startupOperator: string | undefined, commands?: CoordinatorCommands): asserts session is Session & { operator: string } {
  if (!session.operator || !startupOperator || session.operator !== startupOperator || (commands && commands.configuredOperator() !== startupOperator)) {
    throw new HttpError(403, 'operator-unavailable', 'The configured operator changed or is missing. Setup remains CLI-only.');
  }
}

function parseRequestUrl(req: IncomingMessage, port: number): URL {
  return new URL(req.url ?? '/', `http://${HOST}:${port}`);
}

function readJsonBody(req: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
        rejectBody(new HttpError(413, 'body-too-large', 'The request body is too large.'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        const parsed: unknown = body.trim() === '' ? {} : JSON.parse(body);
        if (!isObject(parsed)) throw new Error('JSON body must be an object.');
        resolveBody(parsed);
      } catch (err) {
        rejectBody(new HttpError(400, 'invalid-json', err instanceof Error ? err.message : 'Invalid JSON body.'));
      }
    });
    req.on('error', rejectBody);
  });
}

async function resolveRepoRoots(input: string[] | undefined): Promise<string[]> {
  const configured = input ?? (process.env['AGENTSYS_UI_REPO_ROOTS']?.split(',').map((value) => value.trim()).filter(Boolean));
  const roots = configured && configured.length > 0 ? configured : [process.cwd()];
  return await Promise.all(roots.map(async (root) => {
    if (!isAbsolute(root)) throw new Error(`UI repository root must be absolute: ${root}`);
    return await realpath(root);
  }));
}

async function allowlistedPath(input: string, roots: string[]): Promise<string> {
  if (!isAbsolute(input)) throw new HttpError(422, 'invalid-repo-path', 'repoPath must be absolute.');
  const resolved = await safeRealpath(input);
  if (!resolved || !roots.some((root) => isWithin(root, resolved))) throw new HttpError(403, 'repo-path-not-allowed', 'repoPath is outside the trusted UI repository roots.');
  return resolved;
}

async function safeRealpath(path: string): Promise<string | undefined> {
  try { return await realpath(path); } catch { return undefined; }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel));
}

function safeEvidenceName(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return /^[\w.-]+$/.test(name) && TEXT_CONTENT_TYPES.has(ext);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function randomToken(): string { return randomBytes(32).toString('base64url'); }

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('UI port must be an integer from 0 through 65535.');
  return port;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, type: string, body: string, cacheable: boolean): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cacheable ? 'no-cache' : 'no-store' });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } });
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'");
}

function optionalQuery(url: URL, key: string): boolean { return url.searchParams.get(key) !== null; }
function isObject(value: unknown): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function optionalRuntime(value: string | null | undefined): RuntimeId | undefined { return value && RUNTIMES.includes(value as RuntimeId) ? value as RuntimeId : undefined; }
function requiredRuntime(body: JsonObject, key: string): RuntimeId { const value = requiredText(body, key, 64); const runtime = optionalRuntime(value); if (!runtime) throw new HttpError(422, 'invalid-runtime', `${key} is not supported.`); return runtime; }
function runtimeList(value: unknown): RuntimeId[] { if (!Array.isArray(value) || value.length === 0) throw new HttpError(422, 'invalid-runtimes', 'runtimes must be a non-empty array.'); return value.map((item) => { const runtime = optionalRuntime(typeof item === 'string' ? item : undefined); if (!runtime) throw new HttpError(422, 'invalid-runtime', 'runtimes contains an unsupported runtime.'); return runtime; }); }
function actionList(body: JsonObject, key: string): ActionId[] { const value = body[key]; if (!Array.isArray(value) || value.length === 0) throw new HttpError(422, 'invalid-actions', `${key} must be a non-empty array.`); return value.map((item) => { if (typeof item !== 'string' || !VALID_ACTIONS.includes(item as ActionId)) throw new HttpError(422, 'invalid-action', 'An action is unknown.'); return item as ActionId; }); }
function stringList(body: JsonObject, key: string): string[] { const value = body[key]; if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim() === '')) throw new HttpError(422, 'invalid-list', `${key} must be a non-empty list of strings.`); return value as string[]; }
function stringRecord(value: unknown, key: string): Record<string, string> { if (!isObject(value) || Object.entries(value).some(([name, item]) => name.length > 256 || typeof item !== 'string' || item.length > 1_000)) throw new HttpError(422, 'invalid-record', `${key} must be a record of bounded strings.`); return value as Record<string, string>; }
function windowList(value: unknown): PolicyInput['applicableWindows'] { if (!Array.isArray(value) || value.length === 0 || value.some((item) => item !== 'five-hour' && item !== 'weekly')) throw new HttpError(422, 'invalid-windows', 'applicableWindows must contain five-hour and/or weekly.'); return value as PolicyInput['applicableWindows']; }
function requiredFingerprint(body: JsonObject, key: string): string { const value = requiredText(body, key, 64); if (!/^[a-f0-9]{64}$/.test(value)) throw new HttpError(422, 'invalid-fingerprint', `${key} must be the current Inspect action token.`); return value; }
function requiredText(body: JsonObject, key: string, max: number): string { const value = body[key]; if (typeof value !== 'string' || value.trim() === '') throw new HttpError(422, 'missing-field', `${key} is required.`); if (value.length > max) throw new HttpError(422, 'field-too-long', `${key} is longer than ${max} characters.`); return value; }
function optionalText(body: JsonObject, key: string, max: number): string | undefined { if (body[key] === undefined) return undefined; return requiredText(body, key, max); }
function valueString(body: JsonObject, key: string): string | undefined { return typeof body[key] === 'string' ? body[key] : undefined; }
function boundedNumber(value: unknown, key: string, min: number, max: number): number { const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN; if (!Number.isFinite(number) || number < min || number > max) throw new HttpError(422, 'invalid-number', `${key} must be between ${min} and ${max}.`); return number; }
function requiredEstimateBasis(value: unknown): UsageEstimate['basis'] { if (typeof value !== 'string' || !(ESTIMATE_BASES as readonly string[]).includes(value)) throw new HttpError(422, 'invalid-estimate-basis', 'estimate basis is invalid.'); return value as UsageEstimate['basis']; }
function safeId(value: string, pattern: RegExp): string { if (!pattern.test(value)) throw new HttpError(422, 'invalid-id', 'The identifier is invalid.'); return value; }
function optionalParams(params: URLSearchParams, names: string[]): Record<string, string> { const result: Record<string, string> = {}; for (const name of names) { const value = params.get(name); if (value !== null) result[name] = value; } return result; }
async function loadStaticFiles(staticDir: string, overrides: UiServerOptions['staticFiles']): Promise<Record<string, { body: string; type: string }>> {
  const files: Record<string, { body: string; type: string }> = {};
  for (const [route, filename, type] of [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/index.html', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ] as const) {
    const override = overrides?.[route];
    files[route] = { body: override ?? await readFile(join(staticDir, filename), 'utf8'), type };
  }
  for (const [route, body] of Object.entries(overrides ?? {})) {
    if (typeof body !== 'string') continue;
    files[route] = {
      body,
      type: route.endsWith('.js') ? 'text/javascript; charset=utf-8' : route.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8',
    };
  }
  return files;
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'HttpError'; }
}

async function main(): Promise<void> {
  const handle = await startUiServer();
  console.log(`Local control UI: ${handle.url}`);
  const stop = (): void => { void handle.close().finally(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await once(handle.server, 'close');
}

function isMainModule(): boolean {
  return pathToFileURL(process.argv[1] ?? '').href === import.meta.url;
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
