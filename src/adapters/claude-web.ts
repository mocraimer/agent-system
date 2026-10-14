import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Outcome } from '../core/outcome.js';
import type { SettingsSnapshot, SkillEvidence } from '../core/run.js';
import type { AccountIdentity, UsageResult, UsageWindow } from '../core/usage.js';
import { maxLockedOperationMs } from '../core/store.js';
import { classifyWindow } from '../core/usage.js';
import type {
  DispatchInput, DispatchResult, RuntimeAdapter, RuntimeCapabilities,
} from './types.js';
import { resolveSettings, snapshot } from './types.js';

const run = promisify(execFile);

/** Claude Code resolves plugin skills by plugin-qualified name. */
const SKILL_COMMAND = '/manifest-dev:auto';
const REVIEW_PR_COMMAND = '/manifest-dev-tools:review-pr';

export const CLAUDE_WEB_CAPABILITIES: RuntimeCapabilities = {
  runtime: 'claude-web',
  subscriptionId: 'claude-max',
  supportsModelSelection: true,
  supportsEffortSelection: true,
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  // `--cloud <session_id>` returns an acknowledgement, never a result, so the
  // effective model and effort the vendor session ran with are never reported
  // back. Claiming otherwise would let a run record echo the request as though
  // the vendor had confirmed it.
  reportsEffectiveSettings: false,
  acceptsCallerSessionId: true,
  skillInvocationForm: `${SKILL_COMMAND} <task> or ${REVIEW_PR_COMMAND} <task>`,
};

/** Percentages as `/usage` prints them, e.g. "Current session: 19% used · resets Sep 9, 1:09am". */
const USAGE_LINE = /^(Current session|Current week \(all models\)|Current week \(([^)]+)\)):\s*(\d+)%\s*used(?:\s*·\s*resets\s*(.+))?$/;

export class ClaudeWebAdapter implements RuntimeAdapter {
  readonly capabilities = CLAUDE_WEB_CAPABILITIES;

  constructor(
    private readonly bin = 'claude',
    /** Set once the operator has created a cloud session; see checkReadiness. */
    private readonly cloudSessionId?: string,
  ) {}

  /**
   * Read plan usage through `/usage`.
   *
   * This is a local read: it reports zero turns and zero cost, so polling it
   * before every dispatch does not itself consume the allowance being measured.
   */
  async readUsage(): Promise<UsageResult> {
    const attemptedAt = new Date().toISOString();
    try {
      // Both reads are local and cost nothing, and they run concurrently so naming
      // the account does not lengthen the time the admission lock is held.
      const [usage, account] = await Promise.all([
        run(this.bin, ['-p', '/usage', '--output-format', 'json'], {
          maxBuffer: 8 * 1024 * 1024,
          // This runs inside the admission lock. A read slower than the lock's
          // staleness window would let a waiting dispatcher break the lock and enter
          // admission alongside us — both then seeing the same free headroom.
          timeout: maxLockedOperationMs(),
        }),
        this.accountIdentity(),
      ]);
      const { stdout } = usage;
      const parsed = JSON.parse(stdout) as { result?: string };
      const windows = parseUsageWindows(parsed.result ?? '');
      if (windows.length === 0) {
        return {
          ok: false,
          unavailable: {
            subscriptionId: this.capabilities.subscriptionId,
            attemptedAt,
            source: 'claude -p /usage',
            reason: 'The usage report carried no recognizable window lines.',
            operatorAction: 'Run `claude -p "/usage"` by hand and check the account is a subscription account.',
          },
        };
      }
      return {
        ok: true,
        reading: {
          subscriptionId: this.capabilities.subscriptionId,
          observedAt: attemptedAt,
          source: 'claude -p /usage --output-format json',
          windows,
          ...(account ? { account } : {}),
        },
      };
    } catch (err) {
      return {
        ok: false,
        unavailable: {
          subscriptionId: this.capabilities.subscriptionId,
          attemptedAt,
          source: 'claude -p /usage',
          reason: err instanceof Error ? err.message : String(err),
          operatorAction: 'Check `claude auth status`, then retry.',
        },
      };
    }
  }

  /**
   * Name the account this runtime is signed in as, through `claude auth status`.
   *
   * The point is to let an operator see that the allowance being read is the one
   * the cloud runs will spend. `auth status` also returns an email address; it is
   * deliberately not read, because the organisation id answers the question and an
   * address in a stored record is personal data the record has no use for.
   *
   * Returns undefined rather than throwing: not knowing the account is a gap in
   * the evidence, not a reason to refuse a usage reading that succeeded.
   */
  async accountIdentity(): Promise<AccountIdentity | undefined> {
    try {
      const { stdout } = await run(this.bin, ['auth', 'status'], { timeout: 60_000 });
      const parsed = JSON.parse(stdout) as { orgId?: string; subscriptionType?: string };
      if (!parsed.orgId) return undefined;
      return {
        id: parsed.orgId,
        ...(parsed.subscriptionType ? { plan: parsed.subscriptionType } : {}),
        source: 'claude auth status',
      };
    } catch {
      return undefined;
    }
  }

  async checkReadiness(): Promise<Outcome | undefined> {
    if (!this.cloudSessionId) {
      return {
        kind: 'setup-blocked',
        summary:
          'No Claude cloud session is configured. With `--print`, `--cloud` attaches to an existing session by id or URL, and cannot create one: `--cloud <description>` refuses a non-interactive invocation ("--cloud requires an interactive terminal"), and `--cloud <description> --bg` refuses outright ("--bg and --cloud are different backends").',
        nextAction:
          'Create one cloud session from a terminal (`claude --cloud "<description>"`), then record its id or claude.ai/code URL with `agentsys config --claude-cloud-session <id>`.',
      };
    }
    try {
      await run(this.bin, ['auth', 'status'], { timeout: 60_000 });
      return undefined;
    } catch (err) {
      return {
        kind: 'setup-blocked',
        summary: `Claude Code is not authenticated: ${err instanceof Error ? err.message : String(err)}`,
        nextAction: 'Run `claude` once and sign in, then re-run.',
      };
    }
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    // The approved tier outranks this adapter's own default. It is sent, and it
    // is never confirmed: this runtime reports nothing back, so the snapshot
    // records `unknown` for what actually ran rather than echoing this.
    const resolved = resolveSettings(this.capabilities, input.settings, {
      model: input.approvedTier?.model ?? 'claude-opus-5-5',
      effort: input.approvedTier?.effort ?? 'high',
    });

    const notReady = await this.checkReadiness();
    if (notReady) {
      return {
        outcome: { ...notReady, taskId: input.taskId, runId: input.runId },
        settings: snapshot(this.capabilities, input.settings, resolved),
      };
    }

    mkdirSync(input.evidenceDir, { recursive: true });
    const args = [
      '--cloud', this.cloudSessionId!,
      '-p', input.entry === 'prompt'
        ? input.task
        : `${input.entry === 'review-pr' ? REVIEW_PR_COMMAND : SKILL_COMMAND} ${input.task}`,
      '--output-format', 'json',
      '--model', resolved.model,
      '--effort', resolved.effort,
    ];
    const invocation = `${this.bin} ${args.map(quoteArg).join(' ')}`;
    const transcript = join(input.evidenceDir, 'claude-web-result.json');

    try {
      const { stdout } = await run(this.bin, args, {
        cwd: input.repoPath,
        maxBuffer: 64 * 1024 * 1024,
        timeout: input.timeoutMs ?? 3_600_000,
      });
      writeFileSync(transcript, stdout, 'utf8');
      const parsed = JSON.parse(stdout) as {
        session_id?: string; result?: unknown; is_error?: boolean; ok?: boolean;
        url?: string; stop_reason?: string | null;
      } | null;
      const failed = parsed?.is_error === true || parsed?.ok === false || parsed?.stop_reason === 'refusal';

      // Attaching to a cloud session hands the prompt over and returns
      // `{ok, session_id, url}` — the run itself continues on the vendor's side.
      // Reading that acknowledgement as a finished run is how a dispatch that has
      // produced nothing yet reads as `completed`, with an empty transcript and no
      // manifest. The work is outstanding, and `remote-uncertain` keeps it that way
      // so its reservation is still held against the account.
      if (!failed && typeof parsed?.result !== 'string') {
        if (parsed?.ok === true && parsed.result === undefined) {
          return this.acknowledged(input, resolved, invocation, transcript, parsed.url);
        }
        return {
          outcome: {
            kind: 'remote-uncertain', taskId: input.taskId, runId: input.runId,
            summary: 'Claude cloud returned neither a readable result nor a confirmed acknowledgement.',
            nextAction: `Read the retained response and check https://claude.ai/code/${this.cloudSessionId} before dispatching again.`,
            details: { transcript },
          },
          settings: snapshot(this.capabilities, input.settings, resolved),
          sessionId: this.cloudSessionId!,
          artifacts: { transcript },
        };
      }

      const skill: SkillEvidence = {
        distributionPath: `cloud session ${this.cloudSessionId!}`,
        distributionVersion: 'unknown',
        invocation,
        continuation: failed ? 'interrupted' : 'completed',
      };
      const manifestPath = findManifestPath(typeof parsed?.result === 'string' ? parsed.result : '');
      if (manifestPath) skill.manifestPath = manifestPath;

      return {
        outcome: {
          kind: failed ? 'checks-failed' : 'completed',
          taskId: input.taskId,
          runId: input.runId,
          summary: parsed?.stop_reason === 'refusal'
            ? 'Claude cloud session refused the request.'
            : failed ? 'Claude cloud session reported an error.' : 'Claude cloud session completed.',
          nextAction: failed
            ? 'Read the retained result, then decide whether to repair or re-dispatch.'
            : 'Review the generated manifest and the run evidence.',
          details: { transcript, ...(manifestPath ? { manifestPath } : {}) },
        },
        settings: snapshot(this.capabilities, input.settings, resolved),
        sessionId: parsed?.session_id ?? this.cloudSessionId!,
        skill,
        artifacts: { transcript },
      };
    } catch (err) {
      return {
        outcome: {
          kind: 'remote-uncertain',
          taskId: input.taskId,
          runId: input.runId,
          summary: `Lost contact with the Claude cloud session: ${err instanceof Error ? err.message : String(err)}`,
          nextAction: `Reconcile with \`agentsys reconcile ${this.cloudSessionId}\` before starting another attempt — the remote session may still be running.`,
        },
        settings: snapshot(this.capabilities, input.settings, resolved),
        ...(this.cloudSessionId ? { sessionId: this.cloudSessionId } : {}),
      };
    }
  }

  /**
   * Record a prompt the cloud session accepted but has not answered.
   *
   * The CLI offers no way to collect the answer: `--output-format stream-json` is
   * refused for `--cloud`, and `claude agents` lists only local background
   * sessions. So the honest record is an outstanding run pointing at the session,
   * not a completed one pointing at an acknowledgement.
   */
  private acknowledged(
    input: DispatchInput,
    resolved: SettingsSnapshot['resolved'],
    invocation: string,
    transcript: string,
    url?: string,
  ): DispatchResult {
    const session = this.cloudSessionId!;
    return {
      outcome: {
        kind: 'remote-uncertain',
        taskId: input.taskId,
        runId: input.runId,
        summary:
          `Claude cloud session ${session} accepted the prompt and is running it. ` +
          'Attaching to a cloud session returns an acknowledgement, not a result, so this run has no outcome yet.',
        nextAction:
          `Read the session at ${url ?? `https://claude.ai/code/${session}`} to see what it did, then record the result. ` +
          `Do not dispatch this task again first: \`agentsys reconcile ${session} --runtime claude-web\` reports what is known.`,
        details: { transcript, ...(url ? { sessionUrl: url } : {}) },
      },
      settings: snapshot(this.capabilities, input.settings, resolved),
      sessionId: session,
      skill: {
        // The skill loads inside the vendor's cloud environment, not from this
        // machine's plugin cache. Naming a local path and a version here would
        // assert a distribution this run never touched.
        distributionPath: `cloud session ${session}`,
        distributionVersion: 'unknown',
        invocation,
        continuation: 'running',
      },
      artifacts: { acknowledgement: transcript },
    };
  }

  async reconcile(sessionId: string): Promise<Outcome> {
    try {
      const { stdout } = await run(this.bin, ['agents', '--json', '--all'], { timeout: 60_000 });
      const agents = JSON.parse(stdout) as Array<{ id?: string; status?: string }>;
      const found = agents.find((a) => a.id === sessionId);
      if (!found) {
        // Expected for a cloud session: `claude agents` lists local background and
        // interactive sessions, and cloud sessions are a different backend. Saying
        // "not listed" without saying that would send an operator looking for a
        // local session that was never supposed to be there.
        return {
          kind: 'remote-uncertain',
          summary:
            `Session ${sessionId} is not listed by \`claude agents\`, which reports local sessions only. ` +
            'No CLI command reports the state of a cloud session.',
          nextAction:
            `Open https://claude.ai/code/${sessionId} to see whether it is still running. Do not start a second attempt until its state is known.`,
        };
      }
      return {
        kind: found.status === 'completed' ? 'completed' : 'remote-uncertain',
        summary: `Session ${sessionId} reports status "${found.status ?? 'unknown'}".`,
        nextAction:
          found.status === 'completed'
            ? 'Fetch its result and continue.'
            : 'Wait for it to settle, or stop it explicitly with `claude stop`.',
      };
    } catch (err) {
      return {
        kind: 'remote-uncertain',
        summary: `Could not list Claude sessions: ${err instanceof Error ? err.message : String(err)}`,
        nextAction: 'Check the session at claude.ai/code before dispatching again.',
      };
    }
  }
}

/**
 * Parse the account-wide window lines from a `/usage` report.
 *
 * Only the leading window lines are account-wide. The "What's contributing"
 * breakdown below them is explicitly local-machine attribution, so it is not
 * read here — treating it as account usage is the mistake the contract calls out.
 */
export function parseUsageWindows(report: string): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const rawLine of report.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith("What's contributing")) break;
    const m = USAGE_LINE.exec(line);
    if (!m) continue;
    const [, label, modelQualifier, percent, resets] = m;
    // A model-specific weekly bucket is its own limit, not the account weekly one.
    const isModelSpecific = modelQualifier !== undefined && modelQualifier !== 'all models';
    const vendorLabel = label!;
    const window: UsageWindow = {
      kind: isModelSpecific ? 'other' : classifyWindow(undefined, vendorLabel),
      usedPercent: Number(percent),
      vendorLabel,
    };
    if (resets) window.resetsAt = resets.trim();
    windows.push(window);
  }
  return windows;
}

function findManifestPath(text: string): string | undefined {
  return /(\/[\w./-]*\.manifest-dev\/manifests\/manifest-[\w-]+\.md)/.exec(text)?.[1];
}

function quoteArg(a: string): string {
  return /[\s"']/.test(a) ? JSON.stringify(a) : a;
}
