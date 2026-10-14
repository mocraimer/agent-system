import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Outcome } from '../core/outcome.js';
import type { SkillEvidence } from '../core/run.js';
import { killGroup } from '../core/proc.js';
import type { UsageResult } from '../core/usage.js';
import { CodexCloudAdapter } from './codex-cloud.js';
import { LineFramer } from './jsonl.js';
import type {
  DispatchInput, DispatchResult, RuntimeAdapter, RuntimeCapabilities,
} from './types.js';
import { resolveSettings, snapshot, UnsupportedSettingError } from './types.js';

/**
 * Where Pi keeps the manifest-dev distribution it loads skills from.
 *
 * Recorded per run rather than assumed: this machine carries manifest-dev at
 * different versions across runtimes. "The skill ran" is only meaningful
 * alongside which copy of it ran.
 */
const PI_MANIFEST_DEV = process.env['AGENTSYS_PI_MANIFEST_DEV']
  ?? join(homedir(), '.pi', 'agent', 'git', 'github.com', 'doodledood', 'manifest-dev');

const runFile = promisify(execFile);

/** Pi registers skills as `/skill:<name>`, not `/<name>`. */
const SKILL_COMMAND = 'skill:auto';
const REVIEW_PR_COMMAND = 'skill:review-pr';

/**
 * Default subscription id for Pi.
 *
 * Pi's configured provider is `openai-codex`, and Codex cloud uses the same id, so
 * by default the two share admission state. That they are the *same ChatGPT account*
 * is an assumption, not a verified fact: Pi and the Codex CLI keep separate
 * credential stores and neither prints a comparable non-secret account identifier.
 * Sharing is the conservative reading — if it is one account this is correct, and if
 * it is two this over-restricts rather than overspends. Override per install once
 * the identity is established.
 */
export const PI_DEFAULT_SUBSCRIPTION = process.env['AGENTSYS_PI_SUBSCRIPTION'] ?? 'openai-codex';

export const PI_CAPABILITIES: RuntimeCapabilities = {
  runtime: 'pi-local',
  subscriptionId: PI_DEFAULT_SUBSCRIPTION,
  supportsModelSelection: true,
  supportsEffortSelection: true,
  effortLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  reportsEffectiveSettings: true,
  acceptsCallerSessionId: true,
  skillInvocationForm: `/${SKILL_COMMAND} <task> or /${REVIEW_PR_COMMAND} <task>`,
};

export class PiEvidenceError extends Error {
  constructor(
    message: string,
    public readonly localProcessStopped: boolean,
    public readonly processId: number | undefined,
    public readonly sessionId?: string,
  ) {
    super(message);
    this.name = 'PiEvidenceError';
  }
}

export class PiTeardownError extends Error {
  constructor(
    message: string,
    public readonly processId: number | undefined,
    public readonly localProcessStopped: boolean,
    public readonly streamsDrained: boolean,
    public readonly sessionId?: string,
  ) {
    super(message);
    this.name = 'PiTeardownError';
  }
}

interface RpcResponse {
  type: 'response';
  id?: string;
  command: string;
  success: boolean | undefined;
  data?: Record<string, unknown>;
  error?: string;
}

export class PiAdapter implements RuntimeAdapter {
  readonly capabilities = PI_CAPABILITIES;

  newSessionId(): string {
    return randomUUID();
  }

  constructor(
    private readonly bin = 'pi',
    private readonly distributionRoot = PI_MANIFEST_DEV,
    /**
     * How this adapter reads its subscription's usage. Pi has none of its own, and
     * the subscription is Codex's, so the Codex adapter is the reader. Injectable so
     * a test can drive both outcomes without a vendor binary.
     */
    private readonly usageReader: { readUsage(): Promise<UsageResult> } = new CodexCloudAdapter(),
    private readonly appendEvidence: (path: string, data: string | Uint8Array, encoding?: BufferEncoding) => void =
      (path, data, encoding) => appendFileSync(path, data, encoding),
    private readonly teardownTimeoutMs = 10_000,
  ) {}

  private codexUsage(): Promise<UsageResult> {
    return this.usageReader.readUsage();
  }

  /**
   * Pi exposes no account-usage interface of its own.
   *
   * Its provider's usage lives behind the Codex app-server, so this reports the
   * gap rather than inventing a reading. Under INV-G8 a missing reading blocks
   * admission, which is the intended consequence.
   */
  async readUsage(): Promise<UsageResult> {
    // Pi has no usage surface of its own, but its subscription does, and the Codex
    // adapter already knows how to ask and how to tell a failed sign-in from a
    // server that will not start. Asserting a cause here instead produced a message
    // that named the wrong remedy once the real failure changed underneath it: the
    // app-server starts perfectly well and the vendor rejects the refresh token.
    const viaCodex = await this.codexUsage();
    if (viaCodex.ok) return viaCodex;
    return {
      ok: false,
      unavailable: {
        ...viaCodex.unavailable,
        subscriptionId: this.capabilities.subscriptionId,
        source: `pi (no usage interface); read through ${viaCodex.unavailable.source}`,
      },
    };
  }

  async checkReadiness(entry: 'skill' | 'review-pr' | 'prompt' = 'skill'): Promise<Outcome | undefined> {
    if (entry === 'prompt') {
      try {
        await runFile(this.bin, ['--version'], { timeout: 30_000 });
        return undefined;
      } catch (err) {
        return {
          kind: 'setup-blocked',
          summary: `Could not run "${this.bin} --version": ${err instanceof Error ? err.message : String(err)}`,
          nextAction: `Check that ${this.bin} is installed and on PATH for the process running agentsys, then re-run.`,
        };
      }
    }
    const skillPath = entry === 'review-pr'
      ? join(this.distributionRoot, 'claude-plugins/manifest-dev-tools/skills/review-pr/SKILL.md')
      : join(this.distributionRoot, 'claude-plugins/manifest-dev/skills/auto/SKILL.md');
    if (!existsSync(skillPath)) {
      return {
        kind: 'setup-blocked',
        summary: `Pi has no manifest-dev ${entry === 'review-pr' ? 'review-pr' : 'auto'} skill at ${skillPath}.`,
        nextAction:
          'Install or update the manifest-dev package for Pi (`pi install git:github.com/doodledood/manifest-dev`), then re-run.',
      };
    }
    return undefined;
  }

  /** Version of the distribution Pi will actually load, for the run record. */
  distributionVersion(): string {
    try {
      const pkg = JSON.parse(
        readFileSync(join(this.distributionRoot, 'package.json'), 'utf8'),
      ) as { name?: string; version?: string };
      return `${pkg.name ?? 'unknown'}@${pkg.version ?? 'unknown'}`;
    } catch {
      return 'unknown';
    }
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    // The approved tier outranks this adapter's own default and is outranked in
    // turn by what the caller named, which `resolveSettings` prefers.
    const resolved = resolveSettings(this.capabilities, input.settings, {
      model: input.approvedTier?.model ?? 'gpt-6-astra',
      effort: input.approvedTier?.effort ?? 'high',
    });

    const entry = input.entry ?? 'skill';
    const viaSkill = entry !== 'prompt';
    const skillCommand = entry === 'review-pr' ? REVIEW_PR_COMMAND : SKILL_COMMAND;
    const notReady = await this.checkReadiness(entry);
    if (notReady) {
      return {
        outcome: {
          ...notReady, kind: 'checks-failed', taskId: input.taskId, runId: input.runId,
          summary: `${notReady.summary} No task prompt was sent.`,
          promptNotSent: true,
          ...(notReady.details ? { details: notReady.details } : {}),
        },
        settings: snapshot(this.capabilities, input.settings, resolved),
      };
    }

    mkdirSync(input.evidenceDir, { recursive: true });
    const eventLog = join(input.evidenceDir, 'pi-rpc-events.jsonl');

    const args = ['--mode', 'rpc'];
    if (resolved.model !== 'vendor-default') args.push('--model', resolved.model);
    if (resolved.effort !== 'vendor-default') args.push('--thinking', resolved.effort);
    if (input.sessionId) args.push('--session-id', input.sessionId);

    const message = viaSkill ? `/${skillCommand} ${input.task}` : input.task;
    const invocation = viaSkill
      ? `${this.bin} ${args.join(' ')}  <<< ${message}`
      : `${this.bin} ${args.join(' ')}  <<< <prompt as given>`;
    const proc = spawn(this.bin, args, {
      cwd: input.repoPath, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });

    // A ChildProcess with no 'error' listener throws on the event loop when the
    // binary is missing, which no enclosing try/catch can see. Capture it instead.
    let spawnError: Error | undefined;
    proc.on('error', (err: Error) => {
      spawnError = err;
    });
    // ChildProcess 'close' waits for the leader to exit. The pipes can drain
    // while a stubborn leader/group is still alive, and that is useful recovery
    // evidence in its own right.
    let stdoutDrained = false;
    let stderrDrained = false;
    proc.stdout.on('end', () => { stdoutDrained = true; });
    proc.stderr.on('end', () => { stderrDrained = true; });
    const streamsDrained = (): boolean => stdoutDrained && stderrDrained;
    let observedSessionId = input.sessionId;

    let evidenceError: Error | undefined;
    let signalEvidenceFailure!: () => void;
    const evidenceFailure = new Promise<void>((resolve) => { signalEvidenceFailure = resolve; });
    const failEvidence = (path: string, err: unknown): void => {
      if (evidenceError) return;
      evidenceError = new Error(`Could not retain Pi evidence at ${path}: ${err instanceof Error ? err.message : String(err)}`);
      if (proc.pid !== undefined) killGroup(proc.pid);
      else proc.kill();
      signalEvidenceFailure();
    };
    const stopOnEvidenceFailure = async (): Promise<void> => {
      if (!evidenceError) return;
      proc.stdin.destroy();
      const localProcessStopped = await waitForProcessExit(proc, this.teardownTimeoutMs);
      throw new PiEvidenceError(evidenceError.message, localProcessStopped, proc.pid, observedSessionId);
    };
    // Killing Pi with a pending RPC write can emit EPIPE after the write call returns.
    proc.stdin.on('error', () => { /* The evidence error is reported through dispatch. */ });

    const framer = new LineFramer();
    const lines: string[] = [];
    const recordEvent = (line: string): void => {
      if (evidenceError) return;
      try {
        const event: unknown = JSON.parse(line);
        if (isRecord(event)) line = JSON.stringify({ ...event, agentsysReceivedAt: new Date().toISOString() });
      } catch { /* Preserve malformed runtime output as evidence too. */ }
      try {
        this.appendEvidence(eventLog, `${line}\n`, 'utf8');
        lines.push(line);
      } catch (err) {
        failEvidence(eventLog, err);
      }
    };
    recordEvent(JSON.stringify({ type: 'agentsys_phase', phase: 'process-started', processId: proc.pid }));
    const responses = new Map<string, RpcResponse>();
    let settled = false;

    proc.stderr.on('data', (d: Buffer) => {
      if (evidenceError) return;
      const stderrLog = join(input.evidenceDir, 'pi-stderr.log');
      try {
        this.appendEvidence(stderrLog, d);
      } catch (err) {
        failEvidence(stderrLog, err);
      }
    });

    const send = (msg: Record<string, unknown>): void => {
      proc.stdin.write(`${JSON.stringify(msg)}\n`);
    };

    const closeChild = async (recordStop = false): Promise<void> => {
      proc.stdin.end();
      if (proc.pid !== undefined) killGroup(proc.pid);
      else proc.kill();
      const processStopped = await waitForProcessExit(proc, this.teardownTimeoutMs);
      // An 'exit' may precede the last pipe callback. Do not assert that the
      // evidence is complete until both readable streams report EOF.
      await waitFor(streamsDrained, this.teardownTimeoutMs);
      await stopOnEvidenceFailure();
      if (streamsDrained()) {
        for (const line of framer.flush()) recordEvent(line);
        await stopOnEvidenceFailure();
        // Pipe EOF is useful for diagnosis, but does not prove that escaped
        // descendants stopped. Only the final marker certifies local teardown.
        recordEvent(JSON.stringify({ type: 'agentsys_phase', phase: 'streams-closed' }));
        await stopOnEvidenceFailure();
      }
      if (!streamsDrained() || !processStopped) {
        throw new PiTeardownError(
          !streamsDrained() ? 'Pi evidence streams did not drain after process teardown.'
            : 'Pi local process group could not be confirmed stopped after teardown.',
          proc.pid, processStopped, streamsDrained(), observedSessionId,
        );
      }
      // Last evidence write on paths safe to reconcile: task not yet sent or
      // prompt accepted. A rejected/unknown acknowledgement may have emitted
      // agent_settled, but must not be reconciled as completed.
      if (recordStop) {
        recordEvent(JSON.stringify({ type: 'agentsys_local_process_stopped' }));
        await stopOnEvidenceFailure();
      }
    };

    const settledPromise = new Promise<void>((resolve) => {
      proc.stdout.on('data', (d: Buffer) => {
        if (evidenceError) return;
        for (const line of framer.push(d.toString('utf8'))) {
          if (line.trim() === '') continue;
          recordEvent(line);
          if (evidenceError) return;
          let msg: { type?: string; id?: string } | undefined;
          try {
            msg = JSON.parse(line) as { type?: string; id?: string };
          } catch {
            continue; // a non-JSON line is kept in the log but cannot be acted on
          }
          if (msg.type === 'response' && typeof msg.id === 'string') {
            // Preserve unknown separately from explicit acceptance or rejection:
            // a missing or malformed flag does not prove the run never started.
            const raw = msg as Record<string, unknown>;
            responses.set(msg.id, {
              type: 'response',
              id: msg.id,
              command: typeof raw['command'] === 'string' ? raw['command'] : '',
              success: typeof raw['success'] === 'boolean' ? raw['success'] : undefined,
              ...(isRecord(raw['data']) ? { data: raw['data'] } : {}),
              ...(typeof raw['error'] === 'string' ? { error: raw['error'] } : {}),
            });
          }
          // `agent_settled`, not `agent_end`: agent_end can still be followed by a
          // retry or a queued continuation, so treating it as done would cut the run off.
          if (msg.type === 'agent_settled') {
            settled = true;
            resolve();
          }
        }
      });
      proc.on('exit', () => resolve());
    });

    // Prove the skill is registered before relying on it. Pi's print mode silently
    // passes `/skill:...` through as literal text; asking the runtime what commands
    // it has is the difference between "the skill ran" and "the words were typed".
    await stopOnEvidenceFailure();
    send({ id: 'cmds', type: 'get_commands' });
    await waitFor(() => responses.has('cmds') || spawnError !== undefined || evidenceError !== undefined, 15_000);
    await stopOnEvidenceFailure();
    if (spawnError) {
      // A failed spawn has no child or pipes to drain; polling for an exit code
      // here would turn a known setup error into a teardown timeout.
      if (proc.pid !== undefined) await closeChild(true);
      return {
        outcome: {
          kind: 'checks-failed',
          taskId: input.taskId,
          runId: input.runId,
          summary: `Could not start "${this.bin}": ${spawnError.message}. No task prompt was sent.`,
          nextAction: `Check that ${this.bin} is installed and on PATH, then re-run.`,
          promptNotSent: true,
        },
        settings: snapshot(this.capabilities, input.settings, resolved),
      };
    }
    const commandsResponse = responses.get('cmds');
    const available = extractCommandNames(commandsResponse);
    if (viaSkill && !available.includes(skillCommand)) {
      await closeChild(true);
      return {
        outcome: {
          kind: 'checks-failed',
          taskId: input.taskId,
          runId: input.runId,
          summary: `Pi did not register "${skillCommand}"; no task prompt was sent.`,

          nextAction:
            'Check that skill commands are enabled in ~/.pi/agent/settings.json and that the manifest-dev package is installed, then re-run.',
          promptNotSent: true,
          details: { commandsSeen: available.slice(0, 25) },
        },
        settings: snapshot(this.capabilities, input.settings, resolved),
      };
    }

    recordEvent(JSON.stringify({ type: 'agentsys_phase', phase: 'prompt-sent' }));
    await stopOnEvidenceFailure();
    send({ id: 'prompt', type: 'prompt', message });
    await waitFor(() => responses.has('prompt') || evidenceError !== undefined, 30_000);
    await stopOnEvidenceFailure();
    const promptResponse = responses.get('prompt');
    if (promptResponse?.success !== true) {
      const rejected = promptResponse?.success === false;
      await closeChild();
      return {
        outcome: {
          kind: rejected ? 'refused' : 'remote-uncertain',
          taskId: input.taskId,
          runId: input.runId,
          summary: rejected
            ? `Pi rejected the prompt: ${promptResponse.error ?? 'no reason supplied'}`
            : `Pi did not confirm prompt acceptance: ${promptResponse ? 'response carried no boolean success flag' : 'no response within 30s'}. The run may have started.`,
          nextAction: rejected
            ? 'Inspect the retained event log, then re-dispatch.'
            : `Reconcile the session with \`agentsys reconcile ${input.sessionId ?? '<session>'}\` before dispatching another attempt. Inspect the retained event log.`,
          details: { eventLog },
        },
        settings: snapshot(this.capabilities, input.settings, resolved),
      };
    }

    await Promise.race([
      settledPromise,
      evidenceFailure,
      sleep(input.timeoutMs ?? 3_600_000),
    ]);
    await stopOnEvidenceFailure();

    // Read back what actually ran before shutting the session down.
    send({ id: 'state', type: 'get_state' });
    await waitFor(() => responses.has('state') || evidenceError !== undefined, 10_000);
    await stopOnEvidenceFailure();
    const state = responses.get('state')?.data;
    if (typeof state?.['sessionId'] === 'string') observedSessionId = state['sessionId'];

    await closeChild(true);

    const skill: SkillEvidence = {
      distributionPath: this.distributionRoot,
      distributionVersion: this.distributionVersion(),
      invocation,
      continuation: settled ? 'completed' : 'interrupted',
    };
    const manifestPath = findManifestPath(lines);
    if (manifestPath) skill.manifestPath = manifestPath;

    const sessionId = observedSessionId;

    return {
      outcome: settled
        ? {
            kind: 'completed',
            taskId: input.taskId,
            runId: input.runId,
            summary: 'Pi run settled.',
            nextAction: 'Review the generated manifest and the run evidence.',
            details: { eventLog, ...(manifestPath ? { manifestPath } : {}) },
          }
        : {
            kind: 'checks-failed',
            taskId: input.taskId,
            runId: input.runId,
            summary: 'The local Pi process ended without reporting `agent_settled`.',
            nextAction: 'Read the retained event log and inspect what the local run changed before dispatching again.',
            details: { eventLog },
          },
      settings: snapshot(this.capabilities, input.settings, resolved, {
        ...(typeof state?.['thinkingLevel'] === 'string' ? { effort: state['thinkingLevel'] } : {}),
        ...(modelIdOf(state?.['model']) ? { model: modelIdOf(state?.['model'])! } : {}),
      }),
      ...(sessionId ? { sessionId } : {}),
      skill,
      artifacts: { eventLog },
    };
  }

  reconcile(sessionId: string, evidenceDir?: string): Promise<Outcome> {
    const evidence = readPiEvidence(evidenceDir);
    if (evidence.settled && ((!evidence.hasLocalPhase && !evidence.processStopped) ||
      (evidence.processStopped && evidence.promptSent))) {
      return Promise.resolve({
        kind: 'completed',
        summary: `Pi session ${sessionId} reported agent_settled in retained local evidence.`,
        nextAction: 'Review the generated manifest and the run evidence.',
        ...(evidence.eventLog ? { details: { eventLog: evidence.eventLog } } : {}),
      });
    }
    if (evidence.processStopped) {
      // A recorded start without a prompt-sent phase is an early setup failure;
      // the same terminal accounting applies, but the review tier did not run.
      // A retained start and final stop bound the whole local dispatch. Other
      // phase markers alone do not establish that the prompt was never sent.
      const promptNotSent = evidence.processStarted && !evidence.promptSent;
      return Promise.resolve({
        kind: 'checks-failed',
        summary: promptNotSent ? `Pi session ${sessionId} stopped before a task prompt was sent.`
          : `Pi session ${sessionId} ended locally without reporting agent_settled.`,
        nextAction: 'Read the retained event log and inspect what the local run changed before dispatching again.',
        ...(promptNotSent ? { promptNotSent: true } : {}),
        ...(evidence.eventLog ? { details: { eventLog: evidence.eventLog } } : {}),
      });
    }
    // For new-form evidence, neither settlement, pipe EOF nor absence of the
    // original process group proves escaped descendants stopped. The final
    // marker (or operator stop attestation) is required to release admission.
    return Promise.resolve({
      kind: 'remote-uncertain',
      summary: `Pi session ${sessionId} has no final local-stop marker; task and process state remain uncertain.`,
      nextAction: `Quiesce the coordinator, inspect the session under ~/.pi/agent/sessions and check the group and escaped descendants. Once all work is stopped, use \`agentsys resolve-pi\` with operator attestation before retrying.`,
      ...(evidence.eventLog ? { details: { eventLog: evidence.eventLog, ...(evidence.processId !== undefined ? { processId: evidence.processId } : {}) } } : {}),
    });
  }
}

interface PiEvidence {
  settled: boolean;
  hasLocalPhase: boolean;
  processStarted: boolean;
  promptSent: boolean;
  processStopped: boolean;
  processId?: number;
  eventLog?: string;
}

export function retainedPiProcessId(evidenceDir: string | undefined): number | undefined {
  return readPiEvidence(evidenceDir).processId;
}

function readPiEvidence(evidenceDir: string | undefined): PiEvidence {
  if (!evidenceDir) return { settled: false, hasLocalPhase: false, processStarted: false, promptSent: false, processStopped: false };
  const eventLog = join(evidenceDir, 'pi-rpc-events.jsonl');
  if (!existsSync(eventLog)) return { settled: false, hasLocalPhase: false, processStarted: false, promptSent: false, processStopped: false };

  let settled = false;
  let hasLocalPhase = false;
  let processStarted = false;
  let promptSent = false;
  let processStopped = false;
  let processId: number | undefined;
  for (const line of readFileSync(eventLog, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;
    if (raw['type'] === 'agent_settled') settled = true;
    if (raw['type'] === 'agentsys_phase') {
      hasLocalPhase = true;
      if (raw['phase'] === 'prompt-sent') promptSent = true;
      if (raw['phase'] === 'process-started') {
        processStarted = true;
        processId = validProcessId(raw['processId']) ? raw['processId'] : undefined;
      }
    }
    if (raw['type'] === 'agentsys_local_process_stopped') processStopped = true;
  }
  return { settled, hasLocalPhase, processStarted, promptSent, processStopped, ...(processId !== undefined ? { processId } : {}), eventLog };
}

function validProcessId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function processGroupAbsent(
  pid: number | undefined,
  probe: (groupId: number, signal: 0) => void = (groupId, signal) => { process.kill(groupId, signal); },
): boolean {
  if (!validProcessId(pid)) return false;
  try {
    probe(-pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function extractCommandNames(response: RpcResponse | undefined): string[] {
  const raw = response?.data?.['commands'];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => (typeof c === 'string' ? c : (c as { name?: unknown })?.name))
    .filter((n): n is string => typeof n === 'string');
}

/** Pull the manifest path the skill reports, so the run record can cite it. */
function findManifestPath(lines: string[]): string | undefined {
  const pattern = /(\/[\w./-]*\.manifest-dev\/manifests\/manifest-[\w-]+\.md)/;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = pattern.exec(lines[i]!);
    if (m) return m[1];
  }
  return undefined;
}

function modelIdOf(model: unknown): string | undefined {
  if (typeof model === 'string') return model;
  if (model && typeof model === 'object') {
    const id = (model as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}

function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  const stopped = (): boolean => {
    if (proc.exitCode === null && proc.signalCode === null) return false;
    if (proc.pid === undefined) return true;
    return processGroupAbsent(proc.pid);
  };
  if (stopped()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const done = stopped();
      if (done || Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve(done);
      }
    }, 25);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    // Keep the RPC poll alive even if an evidence error just killed the only
    // child process. The long run timeout still uses the unref'd sleep above.
    await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
  }
  return predicate();
}

export { UnsupportedSettingError };
