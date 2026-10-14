import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Outcome } from '../core/outcome.js';
import type { UsageReading, UsageResult, UsageWindow } from '../core/usage.js';
import { classifyWindow } from '../core/usage.js';
import type {
  DispatchInput, DispatchResult, RuntimeAdapter, RuntimeCapabilities,
} from './types.js';
import { resolveSettings, snapshot } from './types.js';
import { maxLockedOperationMs } from '../core/store.js';

const run = promisify(execFile);

/**
 * Codex cloud task creation accepts only `--env`, `--branch` and `--attempts`.
 *
 * Verified against `codex cloud exec --help` on codex-cli 0.143.0: there is no
 * model flag and no reasoning-effort flag. That is why this runtime may run only
 * under a profile that explicitly accepts whatever the vendor picks.
 */
export const CODEX_CLOUD_CAPABILITIES: RuntimeCapabilities = {
  runtime: 'codex-cloud',
  // Shares Pi's default id so the two share admission state. See PI_DEFAULT_SUBSCRIPTION:
  // that they are one ChatGPT account is an assumption, held in the conservative direction.
  subscriptionId: process.env['AGENTSYS_CODEX_SUBSCRIPTION'] ?? 'openai-codex',
  supportsModelSelection: false,
  supportsEffortSelection: false,
  effortLevels: [],
  reportsEffectiveSettings: false,
  acceptsCallerSessionId: false,
  skillInvocationForm: 'environment-installed skill, invoked in the task prompt (review-pr uses /review-pr)',
};

export interface CodexCloudConfig {
  /** Cloud environment id. Required by `codex cloud exec`. */
  envId?: string;
  /**
   * Set only once it has been observed that the cloud environment really loads
   * the manifest-dev skill. Until then this adapter refuses to dispatch.
   */
  skillEntryVerified?: boolean;
  branch?: string;
}

/**
 * Reduce a vendor error to the sentence an operator can act on.
 *
 * The rate-limit failure arrives with the whole HTTP response embedded, so the
 * useful line — "Could not parse your authentication token. Please try signing in
 * again." — was arriving under eight lines of JSON. An operator surface that buries
 * its own instruction in a response body is the thing INV-G30 exists to prevent.
 *
 * The embedded body is preferred when it carries a message, because that is the
 * vendor's own wording; otherwise the outer text is trimmed to one line.
 */
export function summarise(text: string): string {
  const brace = text.indexOf('{');
  if (brace !== -1) {
    try {
      const body = JSON.parse(text.slice(brace)) as { error?: { message?: string } };
      const message = body.error?.message;
      if (message) return `${text.slice(0, brace).trim()} ${message}`.trim();
    } catch {
      // Not JSON after all; fall through to the flat trim below.
    }
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}…` : flat;
}

export class CodexCloudAdapter implements RuntimeAdapter {
  readonly capabilities = CODEX_CLOUD_CAPABILITIES;

  constructor(
    private readonly config: CodexCloudConfig = {},
    private readonly bin = 'codex',
  ) {}

  /**
   * Codex account usage lives behind the app-server JSON-RPC method
   * `account/rateLimits/read`; no CLI flag prints it.
   */
  /**
   * Read Codex account usage through the app-server's `account/rateLimits/read`.
   *
   * The server is started with a process-local `sqlite_home`, a key documented in
   * the installed version's own config schema and separate from `CODEX_HOME`. That
   * matters: the default home fails to initialise its SQLite state on this machine,
   * and pointing `CODEX_HOME` elsewhere would mean duplicating `auth.json`. This
   * moves only the SQLite files and leaves the credential store alone.
   */
  async readUsage(): Promise<UsageResult> {
    const attemptedAt = new Date().toISOString();
    const sqliteHome = mkdtempSync(join(tmpdir(), 'agentsys-codex-sqlite-'));
    try {
      const result = await this.rateLimitsRead(sqliteHome);
      if (result.kind === 'ok') {
        const reading = toReading(this.capabilities.subscriptionId, attemptedAt, result.snapshot);
        // A call that answered but named no window is not a usage reading. Reporting
        // it as one puts an allowance of "nothing known" in front of the operator
        // wearing the shape of a healthy read.
        if (reading.windows.length === 0) {
          return {
            ok: false,
            unavailable: {
              subscriptionId: this.capabilities.subscriptionId,
              attemptedAt,
              source: 'codex app-server account/rateLimits/read (process-local sqlite_home)',
              reason: 'The rate-limits answer carried no window with a usedPercent.',
              operatorAction:
                'Run `codex login status`, then read the account\'s limits in the Codex app to check this plan reports any window at all.',
            },
          };
        }
        return { ok: true, reading };
      }
      return {
        ok: false,
        unavailable: {
          subscriptionId: this.capabilities.subscriptionId,
          attemptedAt,
          source: 'codex app-server account/rateLimits/read (process-local sqlite_home)',
          reason: result.reason,
          operatorAction: result.authenticationClass
            ? 'Run `codex login`. The same credential failure blocks Codex cloud, so one sign-in clears both.'
            : 'Check `codex app-server -c sqlite_home=<dir>` starts, then retry.',
        },
      };
    } finally {
      rmSync(sqliteHome, { recursive: true, force: true });
    }
  }

  /** One JSON-RPC exchange against a freshly started app-server. */
  private rateLimitsRead(sqliteHome: string): Promise<RateLimitsOutcome> {
    return new Promise<RateLimitsOutcome>((resolve) => {
      const proc = spawn(this.bin, ['app-server', '-c', `sqlite_home=${JSON.stringify(sqliteHome)}`], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      let buffer = '';
      let settled = false;

      const finish = (outcome: RateLimitsOutcome): void => {
        if (settled) return;
        settled = true;
        proc.kill();
        resolve(outcome);
      };

      proc.on('error', (err) => finish({ kind: 'error', reason: err.message, authenticationClass: false }));
      // A timeout can fire and kill the child just as its `initialize` answer
      // arrives; the handler below then writes to a closed pipe. An unhandled
      // stream error there is an uncaught exception that takes the coordinator
      // down, so it is swallowed — `settled` already gates every state change.
      proc.stdin.on('error', () => {});
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
      proc.stdout.on('data', (d: Buffer) => {
        buffer += d.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() === '') continue;
          let msg: { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
          try {
            msg = JSON.parse(line) as typeof msg;
          } catch {
            continue;
          }
          if (msg.id === 1) {
            proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} })}\n`);
          } else if (msg.id === 2) {
            if (msg.error) {
              const text = `${msg.error.code ?? ''} ${msg.error.message ?? ''}`.trim();
              finish({
                kind: 'error',
                reason: `account/rateLimits/read failed: ${summarise(text) || 'no message'}`,
                // The server starts; the read is refused. That is the credential
                // condition, not a startup one, and it is the same one cloud hits.
                authenticationClass: /auth|401|unauthor|token|credential/i.test(text),
              });
            } else {
              finish({ kind: 'ok', snapshot: msg.result });
            }
          }
        }
      });
      proc.on('exit', () => finish({
        kind: 'error',
        reason: `app-server exited before answering: ${stderr.trim().split('\n')[0] ?? 'no output'}`,
        authenticationClass: false,
      }));

      proc.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { clientInfo: { name: 'agentsys', version: '0.1.0' } },
      })}\n`);

      setTimeout(() => finish({
        kind: 'error', reason: 'app-server did not answer in time', authenticationClass: false,
      }), maxLockedOperationMs()).unref();
    });
  }

  async checkReadiness(): Promise<Outcome | undefined> {
    if (!this.config.envId) {
      return {
        kind: 'setup-blocked',
        summary: 'No Codex cloud environment id is configured; `codex cloud exec` requires `--env`.',
        nextAction:
          'Browse environments with `codex cloud`, then record the id with `agentsys config --codex-env <ENV_ID>`.',
      };
    }
    try {
      await run(this.bin, ['cloud', 'list', '--limit', '1', '--json'], { timeout: 120_000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const unauthorized = /401|unauthor/i.test(message);
      return {
        kind: 'setup-blocked',
        summary: unauthorized
          ? 'Codex cloud rejected the stored credential (401). `codex login status` can still report "logged in" while the token is no longer accepted.'
          : `Codex cloud is unreachable: ${message}`,
        nextAction: 'Run `codex login` and re-check with `codex cloud list --limit 1`.',
      };
    }
    if (this.config.skillEntryVerified !== true) {
      // Fail closed. A cloud run that merely receives the words "/auto" in a
      // prompt has not entered the skill, and its result must not be accepted as
      // though it had.
      return {
        kind: 'setup-blocked',
        summary:
          'The Codex cloud environment is not confirmed to load the manifest-dev skill, so a run there cannot be shown to have entered it.',
        nextAction:
          'Do not try to install it from the environment setup script: that script runs in a '
          + 'build container with no `codex` binary, so it fails with "codex: command not found" '
          + '(observed 2026-09-10, exit 127). Establish some other route by which the environment '
          + 'loads the skill, observe a real cloud run entering it, then set `skillEntryVerified` '
          + 'with `agentsys config --codex-skill-verified`.',
      };
    }
    return undefined;
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    // Throws unless the profile accepts vendor-default, which is the point.
    // `approvedTier` is deliberately not read here: this runtime declares that it
    // takes neither setting, so an approval naming one is refused when it is
    // written and can never reach this call.
    const resolved = resolveSettings(this.capabilities, input.settings);

    const notReady = await this.checkReadiness();
    if (notReady) {
      return {
        outcome: { ...notReady, taskId: input.taskId, runId: input.runId },
        settings: snapshot(this.capabilities, input.settings, resolved),
      };
    }

    mkdirSync(input.evidenceDir, { recursive: true });
    const args = ['cloud', 'exec', '--env', this.config.envId!];
    if (this.config.branch) args.push('--branch', this.config.branch);
    args.push(input.entry === 'review-pr' ? `/review-pr ${input.task}` : input.task);

    try {
      const { stdout } = await run(this.bin, args, {
        cwd: input.repoPath,
        maxBuffer: 32 * 1024 * 1024,
        timeout: input.timeoutMs ?? 3_600_000,
      });
      const submission = join(input.evidenceDir, 'codex-cloud-submit.txt');
      writeFileSync(submission, stdout, 'utf8');
      const taskId = /\b(task_[A-Za-z0-9_-]+)\b/.exec(stdout)?.[1];

      return {
        outcome: {
          // A task id confirms submission, not that the cloud work has stopped.
          kind: 'remote-uncertain',
          taskId: input.taskId,
          runId: input.runId,
          summary: taskId
            ? `Codex cloud accepted task ${taskId}.`
            : 'Codex cloud accepted the submission but reported no task id.',
          nextAction: taskId
            ? `Poll it with \`codex cloud status ${taskId}\` and fetch its diff with \`codex cloud diff ${taskId}\`.`
            : 'Find the task with `codex cloud list --json` before submitting another.',
          details: { submission },
        },
        // Effective model and effort stay unknown: the vendor exposes neither.
        settings: snapshot(this.capabilities, input.settings, resolved),
        ...(taskId ? { sessionId: taskId } : {}),
        artifacts: { submission },
      };
    } catch (err) {
      return {
        outcome: {
          kind: 'remote-uncertain',
          taskId: input.taskId,
          runId: input.runId,
          summary: `Codex cloud submission did not confirm: ${err instanceof Error ? err.message : String(err)}`,
          nextAction:
            'Check `codex cloud list --json` for a task created by this attempt before submitting another — the submission may have landed.',
        },
        settings: snapshot(this.capabilities, input.settings, resolved),
      };
    }
  }

  async reconcile(sessionId: string): Promise<Outcome> {
    try {
      const { stdout } = await run(this.bin, ['cloud', 'list', '--limit', '20', '--json'], {
        timeout: 120_000,
      });
      const found = stdout.includes(sessionId);
      // Either way this stays uncertain: Codex cloud exposes no cancellation and
      // no per-task JSON status, so neither presence nor absence in a 20-row page
      // establishes that the task stopped.
      return {
        kind: 'remote-uncertain',
        summary: found
          ? `Codex cloud still lists task ${sessionId}.`
          : `Task ${sessionId} is not in the most recent 20 cloud tasks.`,
        nextAction: found
          ? `Read its state with \`codex cloud status ${sessionId}\`. Codex cloud exposes no cancellation, so an unfinished task keeps its reservation.`
          : 'Page further with `codex cloud list --cursor`, or open the task in the Codex web UI.',
      };
    } catch (err) {
      return {
        kind: 'remote-uncertain',
        summary: `Could not list Codex cloud tasks: ${err instanceof Error ? err.message : String(err)}`,
        nextAction: 'Restore cloud access with `codex login`, then reconcile before dispatching again.',
      };
    }
  }
}

type RateLimitsOutcome =
  | { kind: 'ok'; snapshot: unknown }
  | { kind: 'error'; reason: string; authenticationClass: boolean };

/**
 * Find the rate-limit snapshot inside an `account/rateLimits/read` result.
 *
 * The server nests it under `rateLimits`; the windows are not on the result
 * itself. Reading the wrong level produced a reading that reported `ok` with no
 * windows in it — an answer shaped like a healthy read that says nothing. A
 * snapshot passed in already unwrapped is still accepted, so a caller holding
 * one does not have to re-wrap it.
 */
function rateLimitsOf(snapshot: unknown): Record<string, unknown> {
  const s = (snapshot ?? {}) as Record<string, unknown>;
  const nested = s['rateLimits'];
  if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  return s;
}

/**
 * Turn a `RateLimitSnapshot` into a reading.
 *
 * Windows are classified by their reported `windowDurationMins`, never by whether
 * the vendor called them primary or secondary — the schema makes both nullable and
 * says nothing about which is which.
 */
export function toReading(subscriptionId: string, observedAt: string, snapshot: unknown): UsageReading {
  const windows: UsageWindow[] = [];
  const s = rateLimitsOf(snapshot);
  for (const label of ['primary', 'secondary'] as const) {
    const w = s[label] as Record<string, unknown> | null | undefined;
    if (!w || typeof w['usedPercent'] !== 'number') continue;
    const durationMins = typeof w['windowDurationMins'] === 'number' ? w['windowDurationMins'] : undefined;
    const window: UsageWindow = {
      kind: classifyWindow(durationMins, label),
      usedPercent: w['usedPercent'],
      vendorLabel: label,
      ...(durationMins !== undefined ? { windowDurationMins: durationMins } : {}),
      ...(typeof w['resetsAt'] === 'number'
        ? { resetsAt: new Date(w['resetsAt'] * 1000).toISOString() }
        : {}),
    };
    windows.push(window);
  }
  return { subscriptionId, observedAt, source: 'codex app-server account/rateLimits/read', windows };
}
