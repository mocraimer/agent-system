import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Actor } from '../core/authority.js';
import { assertOperator } from '../core/authority.js';
import { requiredPrBase } from '../core/floor.js';
import { getRun, saveRun } from '../core/run.js';
import { withLockAsync } from '../core/store.js';
import { getScorecard, saveScorecard } from '../eval/scorecard.js';
import type { LoopRecord } from '../eval/scorecard.js';
import type { PullRequest, Store } from './github.js';
import { parseReviewMarkers } from './markers.js';

export class AttestationError extends Error {
  override readonly name = 'AttestationError';
}

export interface AttestationInput {
  runId: string;
  pr: number;
  head: string;
  bodyDigest?: string;
  reason: string;
}

function digest(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function retained(path: string | undefined, directory = false): boolean {
  if (!path || !existsSync(path)) return false;
  const info = statSync(path);
  return directory ? info.isDirectory() : info.isFile() && info.size > 0;
}

function currentPull(pulls: PullRequest[], input: AttestationInput, branch: string, base: string): PullRequest {
  const pr = pulls.find((pull) => pull.number === input.pr);
  if (!pr || pr.state?.toUpperCase() !== 'OPEN' || pr.headRefName !== branch ||
      pr.baseRefName !== base || pr.headRefOid.toLowerCase() !== input.head.toLowerCase()) {
    throw new AttestationError(`PR #${input.pr} is not currently open at ${branch} → ${base} on head ${input.head}.`);
  }
  return pr;
}

/**
 * A person attests a completed run's delivery after inspecting its retained
 * evidence. PR facts constrain the claim; they do not prove who made the edit.
 * This does not call any Store writer and grants no merge authority.
 */
export async function attestDelivery(actor: Actor, store: Store, input: AttestationInput): Promise<NonNullable<LoopRecord['attestedDelivery']>> {
  assertOperator(actor);
  if (!/^[A-Za-z0-9_-]+$/.test(input.runId)) throw new AttestationError('Use a run ID, not a path.');
  if (!Number.isSafeInteger(input.pr) || input.pr <= 0) throw new AttestationError('PR number must be a positive integer.');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.head)) throw new AttestationError('Head must be a full commit SHA.');
  if (input.bodyDigest !== undefined && !/^[a-f0-9]{64}$/i.test(input.bodyDigest)) {
    throw new AttestationError('Body digest must be a full SHA-256 digest.');
  }
  if (!input.reason?.trim()) throw new AttestationError('An operator reason is required.');

  // The scorecard lock also serializes task scorecard updates. A later attempt
  // never receives this run's attestation: its own run ID is the only owner.
  const initial = getRun(input.runId);
  if (!initial) throw new AttestationError(`No run ${input.runId}.`);
  if (!/^[A-Za-z0-9_-]+$/.test(initial.taskId)) throw new AttestationError('Run has an invalid task ID.');
  return withLockAsync(`scorecard-card_${initial.taskId}`, async () => {
    const run = getRun(input.runId);
    if (!run || run.taskId !== initial.taskId || run.repo !== store.repo ||
        run.status !== 'completed' || run.runtimeDispatched !== true ||
        !run.loop || !['fix', 'sweep'].includes(run.loop.stage)) {
      throw new AttestationError('Run must be a completed, dispatched fix/sweep attempt in this repository.');
    }
    const kind = run.loop.stage === 'fix' ? 'description' : 'sweep';
    const number = kind === 'description' ? /^PR #(\d+)$/.exec(run.loop.item) : /^#(\d+)$/.exec(run.loop.item);
    if (!number || (kind === 'description' && Number(number[1]) !== input.pr)) {
      throw new AttestationError('PR does not match the run’s loop item.');
    }
    const ticket = Number(number[1]);
    if (!Number.isSafeInteger(ticket) || ticket <= 0) throw new AttestationError('Run has an invalid loop item.');
    const branch = kind === 'sweep' ? `ticket/${ticket}` : run.loop.fixBranch;
    const base = kind === 'sweep' ? run.loop.sweepBase : run.loop.fixBase;
    const requiredBase = requiredPrBase(store.repo);
    if (!branch || !/^ticket\/\d+$/.test(branch) || !base || (requiredBase && base !== requiredBase)) {
      throw new AttestationError('Run has no valid dispatch-time PR branch and base.');
    }
    if (!retained(run.evidenceDir, true) ||
        (kind === 'description' && !retained(run.outputPath)) ||
        (kind === 'sweep' && !['claude-local-stdout.json', 'pi-rpc-events.jsonl', 'claude-web-result.json']
          .some((file) => retained(join(run.evidenceDir!, file))))) {
      throw new AttestationError('Retained worker result is missing (fix needs output; sweep needs a nonempty runtime result log).');
    }
    if (kind === 'description') {
      if (!run.loop.head || !run.loop.descriptionBeforeDigest ||
          !/^[a-f0-9]{64}$/i.test(run.loop.descriptionBeforeDigest)) {
        throw new AttestationError('Fix run has no dispatch-time head or description baseline digest.');
      }
      if (run.loop.head.toLowerCase() !== input.head.toLowerCase()) {
        throw new AttestationError('Fix head moved since dispatch; a description-only delivery cannot be attested.');
      }
      if (!input.bodyDigest) throw new AttestationError('Fix attestation needs --body-digest for the current PR description.');
    } else if (run.loop.sweepNoPullAtDispatch !== true) {
      throw new AttestationError('Sweep run has no recorded absence of a PR at dispatch.');
    }
    if (kind === 'sweep' && input.bodyDigest !== undefined) {
      throw new AttestationError('A sweep attestation does not use a description digest.');
    }

    // Both branches were pinned at dispatch. Never derive fix ownership from the
    // PR body, its edits or its commit history.
    const pulls = await store.pullsFromHead(branch);
    const pr = currentPull(pulls, input, branch, base);
    const bodyDigest = kind === 'description' ? digest(pr.body) : undefined;
    const reviewedAtAttestation = kind === 'description'
      ? [...await store.comments(pr.number)].reverse().find((c) => parseReviewMarkers(c.body).length > 0)?.id
      : undefined;
    if (kind === 'description' && (bodyDigest !== input.bodyDigest?.toLowerCase() || bodyDigest === run.loop.descriptionBeforeDigest?.toLowerCase())) {
      throw new AttestationError('PR description digest is stale or unchanged from the dispatch baseline.');
    }

    const card = getScorecard(`card_${run.taskId}`);
    if (card && card.repo !== store.repo) throw new AttestationError('Run and scorecard repositories disagree.');
    const recordOnCard = (entry: NonNullable<LoopRecord['attestedDelivery']>): void => {
      if (!card || !card.runIds.includes(run.id) || card.attestedDeliveries?.some((d) => d.runId === run.id)) return;
      const currentLoop = card.runIds.at(-1) === run.id && card.loop?.stage === run.loop!.stage && card.loop.item === run.loop!.item;
      saveScorecard({ ...card, attestedDeliveries: [...(card.attestedDeliveries ?? []), entry],
        ...(currentLoop ? { loop: { ...card.loop!, attestedDelivery: entry } } : {}) });
    };
    const previous = run.loop.attestedDelivery;
    if (previous || run.delivery?.status === 'delivered') {
      if (!previous || run.delivery?.source !== 'operator-attested' ||
          previous.runId !== run.id || previous.kind !== kind || previous.pr !== input.pr ||
          previous.head.toLowerCase() !== input.head.toLowerCase() || previous.bodyDigest !== bodyDigest ||
          previous.by !== actor.id || previous.reason !== input.reason.trim() ||
          previous.round !== (kind === 'description' ? run.loop.round : undefined) ||
          previous.reviewCommentAtDispatch !== (kind === 'description' ? run.loop.reviewCommentAtDispatch : undefined)) {
        throw new AttestationError('This run already has a different delivery record; conflicting attestation refused.');
      }
      recordOnCard(previous);
      return previous;
    }

    const entry: NonNullable<LoopRecord['attestedDelivery']> = {
      runId: run.id, kind, pr: input.pr, head: input.head.toLowerCase(),
      ...(bodyDigest ? { bodyDigest } : {}),
      ...(kind === 'description' && run.loop.reviewCommentAtDispatch !== undefined
        ? { reviewCommentAtDispatch: run.loop.reviewCommentAtDispatch } : {}),
      ...(reviewedAtAttestation !== undefined ? { reviewCommentAtAttestation: reviewedAtAttestation } : {}),
      ...(kind === 'description' && run.loop.round !== undefined ? { round: run.loop.round } : {}),
      by: actor.id, reason: input.reason.trim(), at: new Date().toISOString(),
    };
    if (card?.loop?.attestedDelivery?.runId === run.id) {
      throw new AttestationError('Scorecard already carries an attestation missing from this run.');
    }
    saveRun({
      ...run, loop: { ...run.loop, attestedDelivery: entry },
      delivery: {
        status: 'delivered', reason: entry.reason, source: 'operator-attested', by: actor.id,
        evidence: [
          `run ${run.id}`, `PR #${entry.pr} (${store.repo})`, `head ${entry.head}`,
          ...(entry.bodyDigest ? [`body sha256:${entry.bodyDigest}`] : []),
        ],
        verifiedAt: entry.at,
      },
    });
    // The task card keeps the attestation through later retries, but the latest
    // attempt's `loop` field is never rewritten with an earlier run's result.
    recordOnCard(entry);
    return entry;
  });
}
