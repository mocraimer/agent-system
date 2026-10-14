import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ActionId } from '../core/authority.js';
import type { Outcome } from '../core/outcome.js';
import type { SkillEvidence } from '../core/run.js';
import { alive, killGroup } from '../core/proc.js';
import { stateRoot } from '../core/store.js';
import type { UsageResult } from '../core/usage.js';
import { CLAUDE_WEB_CAPABILITIES, ClaudeWebAdapter } from './claude-web.js';
import type {
  DispatchInput, DispatchResult, RuntimeAdapter, RuntimeCapabilities,
} from './types.js';
import { resolveSettings, snapshot } from './types.js';

const run = promisify(execFile);

/** Claude Code resolves plugin skills by plugin-qualified name. */
const SKILL_COMMAND = '/manifest-dev:auto';
const REVIEW_PR_COMMAND = '/manifest-dev-tools:review-pr';

export const CLAUDE_LOCAL_CAPABILITIES: RuntimeCapabilities = {
  runtime: 'claude-local',
  // The same account `claude-web` draws on: one `claude` login, one allowance.
  subscriptionId: CLAUDE_WEB_CAPABILITIES.subscriptionId,
  supportsModelSelection: true,
  supportsEffortSelection: true,
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  // `-p --output-format json` names the model that billed, under `modelUsage`.
  // It does not name the effort, so observed effort is always `unknown`.
  reportsEffectiveSettings: true,
  acceptsCallerSessionId: true,
  skillInvocationForm: `${SKILL_COMMAND} <task> or ${REVIEW_PR_COMMAND} <task>; prompt entries are sent as written`,
};

/**
 * What a rate-limited run prints, from the loop script this adapter replaced.
 *
 * Matched only against a run that failed: a review that finished and happens to
 * discuss HTTP 429 is a finished review, not a refusal.
 */
const RATE_LIMIT = /rate.?limit|usage limit|429/i;

/** Tools a run may use when its authority includes changing the repository. */
const WRITE_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,Skill';
/** Tools for a run authorized only to read and comment. */
const READ_TOOLS = 'Bash,Read,Glob,Grep,WebFetch,Skill';
const WRITING_ACTIONS: readonly ActionId[] = ['author-changes', 'push-branch', 'open-pr', 'merge-dev'];

interface ClaudeResult {
  is_error?: boolean;
  stop_reason?: string | null;
  result?: string;
  session_id?: string;
  api_error_status?: number | null;
  modelUsage?: Record<string, unknown>;
  total_cost_usd?: number;
}

/** Where a live local session's process id is kept, so recovery can ask whether it still runs. */
const sessionsDir = (): string => join(stateRoot(), 'claude-local');

/**
 * Claude Code on this machine, run with `claude -p`.
 *
 * Unlike `claude-web`, the run happens here and ends here: the process's exit is
 * the result. Its stdout and stderr go straight to files in the run's evidence
 * directory, so a coordinator that dies mid-run still leaves the output behind
 * for recovery to read.
 */
export class ClaudeLocalAdapter implements RuntimeAdapter {
  readonly capabilities = CLAUDE_LOCAL_CAPABILITIES;

  constructor(
    private readonly bin = 'claude',
    /** Usage is the account's, read the way `claude-web` reads it. Injectable for tests. */
    private readonly usageReader: { readUsage(): Promise<UsageResult> } = new ClaudeWebAdapter(bin),
  ) {}

  readUsage(): Promise<UsageResult> {
    return this.usageReader.readUsage();
  }

  newSessionId(): string {
    return randomUUID();
  }

  /** Both entries need the same thing — a signed-in `claude` — so the entry is not consulted. */
  async checkReadiness(_entry?: 'skill' | 'review-pr' | 'prompt'): Promise<Outcome | undefined> {
    try {
      const { stdout } = await run(this.bin, ['auth', 'status'], { timeout: 60_000 });
      const status = JSON.parse(stdout) as { loggedIn?: boolean };
      if (status.loggedIn !== true) {
        return {
          kind: 'setup-blocked',
          summary: `"${this.bin} auth status" reports no signed-in account.`,
          nextAction: `Run \`${this.bin}\` once and sign in, then re-run.`,
        };
      }
      return undefined;
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      return {
        kind: 'setup-blocked',
        summary: missing
          ? `The "${this.bin}" binary was not found on PATH.`
          : `"${this.bin} auth status" failed: ${err instanceof Error ? err.message : String(err)}`,
        nextAction: missing
          ? `Install Claude Code so \`${this.bin}\` is on PATH for the process running agentsys, then re-run.`
          : `Run \`${this.bin} auth status\` by hand, sign in if needed, then re-run.`,
      };
    }
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const resolved = resolveSettings(this.capabilities, input.settings, {
      model: input.approvedTier?.model ?? 'claude-opus-5-5',
      effort: input.approvedTier?.effort ?? 'medium',
    });
    const settings = (reported?: { model?: string }) =>
      snapshot(this.capabilities, input.settings, resolved, reported);

    const notReady = await this.checkReadiness(input.entry);
    if (notReady) {
      return { outcome: { ...notReady, taskId: input.taskId, runId: input.runId }, settings: settings() };
    }

    mkdirSync(input.evidenceDir, { recursive: true });
    const stdoutPath = join(input.evidenceDir, 'claude-local-stdout.json');
    const stderrPath = join(input.evidenceDir, 'claude-local-stderr.log');
    const sessionId = input.sessionId ?? this.newSessionId();
    const message = input.entry === 'prompt'
      ? input.task
      : input.entry === 'review-pr'
        ? `${REVIEW_PR_COMMAND} ${input.task}`
        : `${SKILL_COMMAND} ${input.task}`;
    const writes = (input.actions ?? []).some((a) => WRITING_ACTIONS.includes(a));
    const args = [
      '-p', message,
      '--output-format', 'json',
      '--model', resolved.model,
      '--effort', resolved.effort,
      '--session-id', sessionId,
      '--permission-mode', 'acceptEdits',
      '--allowedTools', writes ? WRITE_TOOLS : READ_TOOLS,
    ];
    // The task text can be long and is work context; the record keeps the shape of
    // the call, and the evidence directory keeps the full prompt.
    writeFileSync(join(input.evidenceDir, 'claude-local-prompt.txt'), message, 'utf8');
    const invocation = `${this.bin} -p <prompt: claude-local-prompt.txt> ${args.slice(2).map(quoteArg).join(' ')}`;

    const exit = await this.runToFiles(args, input, stdoutPath, stderrPath, sessionId);
    if (exit.spawnError) {
      return {
        outcome: {
          kind: 'setup-blocked',
          taskId: input.taskId,
          runId: input.runId,
          summary: `Could not start "${this.bin}": ${exit.spawnError.message}`,
          nextAction: `Check that ${this.bin} is installed and on PATH for the process running agentsys, then re-run.`,
        },
        settings: settings(),
      };
    }

    const stdout = readText(stdoutPath);
    const stderr = readText(stderrPath);
    const parsed = parseResult(stdout);
    const skill: SkillEvidence = {
      distributionPath: 'claude plugin cache (~/.claude/plugins/cache)',
      distributionVersion: 'unknown',
      invocation,
      continuation: exit.timedOut || exit.signal || exit.code !== 0 || !successfulResult(parsed) ? 'interrupted' : 'completed',
    };
    const manifestPath = findManifestPath(parsed?.result ?? '');
    if (manifestPath) skill.manifestPath = manifestPath;
    const details = { stdout: stdoutPath, stderr: stderrPath, exitCode: exit.code, signal: exit.signal };
    const reported = reportedModel(parsed?.modelUsage, resolved.model);
    const base = { settings: settings(reported), sessionId, skill, artifacts: { stdout: stdoutPath, stderr: stderrPath } };

    if (exit.timedOut || exit.signal) {
      return {
        ...base,
        outcome: {
          kind: 'checks-failed',
          taskId: input.taskId,
          runId: input.runId,
          summary: exit.timedOut
            ? `The local Claude run did not finish within ${Math.round((input.timeoutMs ?? 3_600_000) / 1000)}s and was stopped.`
            : `The local Claude run was stopped by ${exit.signal} before it finished.`,
          nextAction: 'Read the retained stdout and stderr, check what the run changed, then decide whether to dispatch again.',
          details,
        },
      };
    }

    const failed = exit.code !== 0 || !successfulResult(parsed);
    if (failed && (parsed?.api_error_status === 429 || RATE_LIMIT.test(`${parsed?.result ?? ''}\n${stderr}`))) {
      return {
        ...base,
        outcome: {
          kind: 'quota-waiting',
          taskId: input.taskId,
          runId: input.runId,
          summary: 'Claude refused the run on a usage or rate limit.',
          nextAction: 'Wait for the window to reset (`agentsys usage --runtime claude-local`), then dispatch again. This did not spend an attempt.',
          details,
        },
      };
    }
    if (failed) {
      return {
        ...base,
        outcome: {
          kind: 'checks-failed',
          taskId: input.taskId,
          runId: input.runId,
          summary: parsed?.stop_reason === 'refusal'
            ? 'The local Claude run refused the request.'
            : parsed === undefined
              ? `The local Claude run exited ${exit.code} without a readable result.`
              : `The local Claude run reported an error (exit ${exit.code}).`,
          nextAction: 'Read the retained stdout and stderr, then decide whether to repair or dispatch again.',
          details,
        },
      };
    }
    return {
      ...base,
      outcome: {
        kind: 'completed',
        taskId: input.taskId,
        runId: input.runId,
        summary: 'Local Claude run completed.',
        nextAction: 'Review the run evidence and what it changed.',
        details: { ...details, ...(manifestPath ? { manifestPath } : {}) },
      },
    };
  }

  /**
   * Run the process with its output going straight to disk.
   *
   * Detached into its own process group so a timeout stops the tools it started,
   * not only the CLI. The pid is recorded under the session id while it runs,
   * which is what `reconcile` reads.
   */
  private runToFiles(
    args: string[], input: DispatchInput, stdoutPath: string, stderrPath: string, sessionId: string,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; spawnError?: Error }> {
    const out = openSync(stdoutPath, 'w');
    const err = openSync(stderrPath, 'w');
    const pidFile = join(sessionsDir(), `${sessionId}.json`);
    return new Promise((resolve) => {
      let timedOut = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      // A spawn failure can be followed by an `exit`; the first one decides.
      const finish = (result: { code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        closeSync(out);
        closeSync(err);
        rmSync(pidFile, { force: true });
        resolve({ ...result, timedOut });
      };
      const proc = spawn(this.bin, args, {
        cwd: input.repoPath, stdio: ['ignore', out, err], detached: true,
      });
      proc.on('error', (spawnError: Error) => finish({ code: null, signal: null, spawnError }));
      proc.on('exit', (code, signal) => finish({ code, signal }));
      if (proc.pid !== undefined) {
        mkdirSync(sessionsDir(), { recursive: true });
        writeFileSync(pidFile, JSON.stringify({ pid: proc.pid, runId: input.runId, evidenceDir: input.evidenceDir }), 'utf8');
        const pid = proc.pid;
        timer = setTimeout(() => {
          timedOut = true;
          killGroup(pid);
        }, input.timeoutMs ?? 3_600_000);
        timer.unref();
      }
    });
  }

  /** Stop a running session's whole process group, found by the pid recorded under its id. */
  stop(sessionId: string): Promise<boolean> {
    let pid: number | undefined;
    try {
      pid = (JSON.parse(readFileSync(join(sessionsDir(), `${sessionId}.json`), 'utf8')) as { pid?: number }).pid;
    } catch {
      return Promise.resolve(false);
    }
    if (pid === undefined || !alive(pid)) return Promise.resolve(false);
    killGroup(pid);
    return Promise.resolve(true);
  }

  /**
   * Say whether a session whose result was never recorded is still running.
   *
   * A local session has one place to look: the process recorded under its id. A
   * live one is still working; a gone one ended, and its output file says how.
   */
  reconcile(sessionId: string, evidenceDir?: string): Promise<Outcome> {
    const pidFile = join(sessionsDir(), `${sessionId}.json`);
    let record: { pid?: number; evidenceDir?: string } | undefined;
    try {
      record = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid?: number; evidenceDir?: string };
    } catch {
      // Absent, or cut short by a crash mid-write: either way it can say nothing, and
      // a file left behind would answer the same way on every later call.
      rmSync(pidFile, { force: true });
      record = undefined;
    }
    if (record?.pid !== undefined && alive(record.pid)) {
      return Promise.resolve({
        kind: 'remote-uncertain',
        summary: `Local Claude session ${sessionId} is still running as process ${record.pid}.`,
        nextAction: `Wait for it to finish, or stop it with \`kill -TERM -${record.pid}\`, before dispatching again.`,
      });
    }
    const resultDir = record?.evidenceDir ?? evidenceDir;
    const stdout = resultDir ? readText(join(resultDir, 'claude-local-stdout.json')) : '';
    const parsed = parseResult(stdout);
    if (record?.pid !== undefined) rmSync(pidFile, { force: true });
    return Promise.resolve(successfulResult(parsed)
      ? {
          kind: 'completed',
          summary: `Local Claude session ${sessionId} finished after the coordinator lost track of it; its result is on disk.`,
          nextAction: 'Read the run evidence before relying on what it did.',
        }
      : {
          kind: 'checks-failed',
          summary: `Local Claude session ${sessionId} is not running and left no successful result.`,
          nextAction: 'Check what the run changed before dispatching again.',
        });
  }
}



function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function parseResult(stdout: string): ClaudeResult | undefined {
  const text = stdout.trim();
  if (text === '') return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as ClaudeResult : undefined;
  } catch {
    return undefined;
  }
}

function successfulResult(result: ClaudeResult | undefined): result is ClaudeResult & { result: string } {
  return result !== undefined && result.is_error !== true && result.stop_reason !== 'refusal' && typeof result.result === 'string';
}

/**
 * The model the run billed, read from `modelUsage`.
 *
 * Claude Code bills a small model for its own housekeeping alongside the one the
 * session runs on. The resolved model appearing among those keys is evidence it
 * billed; a single different model is reported as a substitution. Several models
 * with the resolved one absent leave the observed model unknown. `canonicalModel`
 * is Claude Code's pricing lookup, not confirmation of an execution model.
 */
function reportedModel(modelUsage: Record<string, unknown> | undefined, resolvedModel: string): { model?: string } {
  const billed = Object.keys(modelUsage ?? {});
  if (billed.includes(resolvedModel)) return { model: resolvedModel };
  return billed.length === 1 ? { model: billed[0]! } : {};
}

function findManifestPath(text: string): string | undefined {
  return /(\/[\w./-]*\.manifest-dev\/manifests\/manifest-[\w-]+\.md)/.exec(text)?.[1];
}

function quoteArg(a: string): string {
  return /[\s"']/.test(a) ? JSON.stringify(a) : a;
}
