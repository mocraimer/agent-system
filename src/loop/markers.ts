import { createHash } from 'node:crypto';

/**
 * The hidden markers the loop reads and writes on GitHub.
 *
 * A marker is how the loop recognises its own writing: every comment it posts is
 * authored by the operator's account, so authorship tells it nothing. Each one is
 * an HTML comment, invisible on GitHub, parsed with a strict pattern so prose that
 * merely mentions a marker does not read as one.
 *
 * Every marker starts `<!-- <prefix>-`, where the prefix is the target repository's
 * "marker prefix" (store-config, "Coordinator protocol"). A process works one
 * repository, so the prefix is set once per process with `useMarkerPrefix` when the
 * policy is read; the exported markers below are live bindings that follow it.
 */

let prefix = 'agentsys';
// Each marker and pattern below starts as a placeholder and gets its value in
// `useMarkerPrefix` at the end of this file; a new one must be assigned there
// too. markers.test.ts fails for any that is not.

/** Opening of the coordinator's review bookkeeping marker. */
export let REVIEW_MARKER_PREFIX = '';

/** The old prefix remains readable so reviews written before `/review-pr` migration still advance. */
const LEGACY_REVIEW_MARKER_PREFIX = 'manifest-dev:review-pr';

export interface ReviewMarker {
  sha: string;
  findings: number;
  /** Reviews written before independence was recorded read as not independent. */
  independent: boolean;
  /** Whether the marker states independence at all; one from before the field existed does not. */
  stated: boolean;
  /** `model·effort`, when the marker names it. */
  reviewer?: string;
  /** PR description read by this review; absent on historical markers. */
  bodyDigest?: string;
}

let REVIEW_MARKER_RE = /$^/g;

/** Every review marker in a comment body, in order. */
export function parseReviewMarkers(body: string): ReviewMarker[] {
  const out: ReviewMarker[] = [];
  for (const match of body.matchAll(REVIEW_MARKER_RE)) {
    const fields = new Map<string, string>();
    for (const pair of (match[1] ?? '').split(/\s+/)) {
      const eq = pair.indexOf('=');
      if (eq > 0) fields.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const sha = fields.get('sha');
    const findings = Number(fields.get('findings'));
    if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha) || !Number.isInteger(findings) || findings < 0) continue;
    const reviewer = fields.get('reviewer');
    const bodyDigest = fields.get('body');
    if (bodyDigest !== undefined && !/^[0-9a-f]{64}$/i.test(bodyDigest)) continue;
    out.push({
      sha,
      findings,
      independent: fields.get('independent') === 'yes',
      stated: fields.has('independent'),
      ...(reviewer ? { reviewer } : {}),
      ...(bodyDigest ? { bodyDigest: bodyDigest.toLowerCase() } : {}),
    });
  }
  return out;
}

/** The phrase every comment the loop posts on a pull request is signed with. */
export const LOOP_SIGNATURE = "dispatched by the coordinator's loop";

export function renderReviewMarker(m: Omit<ReviewMarker, 'stated'> & { reviewer: string }): string {
  return `${REVIEW_MARKER_PREFIX} sha=${m.sha} findings=${m.findings} independent=${m.independent ? 'yes' : 'no'} reviewer=${m.reviewer}${m.bodyDigest ? ` body=${m.bodyDigest}` : ''} -->`;
}

/** Old markers remain readable; a new marker must match the description it reviewed. */
export function reviewMatchesBody(marker: ReviewMarker | undefined, body: string, requireDigest = false): boolean {
  if (!marker) return false;
  if (!marker.bodyDigest) return !requireDigest;
  return marker.bodyDigest === createHash('sha256').update(body).digest('hex');
}

/** The newest review marker across a pull request's comments, oldest comment first. */
export function newestReview(comments: ReadonlyArray<{ body: string }>): ReviewMarker | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    const markers = parseReviewMarkers(comments[i]!.body);
    if (markers.length > 0) return markers[markers.length - 1];
  }
  return undefined;
}

/** True when a marker names the given head, allowing for an abbreviated sha. */
export function markerAt(marker: ReviewMarker | undefined, head: string): boolean {
  if (!marker) return false;
  return head.toLowerCase().startsWith(marker.sha.toLowerCase()) && marker.sha.length >= 7;
}

/* --------------------------------------------------------------- fix rounds */

export let FIX_MARKER_PREFIX = '';

export interface FixMarker {
  round: number;
  /** The head the fix run started from. */
  from: string;
  /** The head after it, or the same head when it pushed nothing. */
  to: string;
}

let FIX_MARKER_RE = /$^/gi;

export function parseFixMarkers(body: string): FixMarker[] {
  return [...body.matchAll(FIX_MARKER_RE)].map((m) => ({ round: Number(m[1]), from: m[2]!, to: m[3]! }));
}

export function renderFixMarker(m: FixMarker): string {
  return `${FIX_MARKER_PREFIX} round=${m.round} from=${m.from} to=${m.to} -->`;
}

export function fixRounds(comments: ReadonlyArray<{ body: string }>): FixMarker[] {
  return comments.flatMap((c) => parseFixMarkers(c.body));
}

/* ------------------------------------------- operator instructions the loop consumed */

export let APPLIED_MARKER_PREFIX = '';
export let ACCEPTED_MARKER_PREFIX = '';

let APPLIED_MARKER_RE = /$^/gi;
let ACCEPTED_MARKER_RE = /$^/gi;

/** Which operator comment a fix run was given, so a later pass can tell it was used. */
export function renderAppliedMarker(m: { comment: number; head: string }): string {
  return `${APPLIED_MARKER_PREFIX} comment=${m.comment} head=${m.head} -->`;
}

export function appliedComments(comments: ReadonlyArray<{ body: string }>): number[] {
  return comments.flatMap((c) => [...c.body.matchAll(APPLIED_MARKER_RE)].map((m) => Number(m[1])));
}

/** The head whose outstanding findings a person accepted. */
export function renderAcceptedMarker(head: string): string {
  return `${ACCEPTED_MARKER_PREFIX} head=${head} -->`;
}

export function acceptedHeads(comments: ReadonlyArray<{ body: string }>): string[] {
  return comments.flatMap((c) => [...c.body.matchAll(ACCEPTED_MARKER_RE)].map((m) => m[1]!));
}

/**
 * True when a person accepted the findings standing against this exact head.
 *
 * An acceptance belongs to the latest review event at that head, not only to
 * the commit: a new same-head review of a changed description may find new work.
 * A push or a later review requires a new human acceptance.
 */
export function findingsAcceptedAt(comments: ReadonlyArray<{ body: string }>, head: string): boolean {
  let reviewedAt = -1;
  let acceptedAt = -1;
  comments.forEach((comment, index) => {
    if (parseReviewMarkers(comment.body).some((marker) => markerAt(marker, head))) reviewedAt = index;
    if (acceptedHeads([comment]).some((sha) => head.toLowerCase().startsWith(sha.toLowerCase()) && sha.length >= 7)) acceptedAt = index;
  });
  return reviewedAt >= 0 && acceptedAt > reviewedAt;
}

/**
 * The newest comment in which a person said something, or undefined where none did.
 *
 * The loop and the operator post under the same GitHub login, so authorship
 * settles nothing. What separates them is that every comment the loop writes
 * carries one of its markers or its signature, and a person's carries neither.
 *
 * A comment that only quotes is not one of these. Quote reply with nothing typed
 * under it leaves a comment whose every line is the loop's, and handing that back
 * to a fix run as an instruction would spend a round on the loop's own output.
 */
export function operatorComment<C extends { id: number; body: string; author?: string }>(
  comments: ReadonlyArray<C>,
  /** Only comments this login wrote, compared without regard to case. */
  by?: string,
): C | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    if (by !== undefined && c.author?.toLowerCase() !== by.toLowerCase()) continue;
    if (writtenByLoop(c.body)) continue;
    if (withoutQuotes(c.body).trim() === '') continue;
    return c;
  }
  return undefined;
}

export let REVIEW_AGAIN_MARKER_PREFIX = '';

/**
 * Where the review count of a pull request the loop did not open starts over.
 *
 * `counted` is how many distinct heads the loop had run a review at when a
 * person asked for more, so what it counts afterwards is the heads past that many,
 * whatever any clock says.
 */
export interface ReviewRestart {
  head: string;
  counted: number;
}

let REVIEW_AGAIN_MARKER_RE = /$^/gi;

export function renderReviewAgainMarker(m: ReviewRestart): string {
  return `${REVIEW_AGAIN_MARKER_PREFIX} head=${m.head} counted=${m.counted} -->`;
}

/** The newest restart a person asked for, or undefined where the count has never restarted. */
export function newestReviewRestart(comments: ReadonlyArray<{ body: string }>): ReviewRestart | undefined {
  const restarts = comments.flatMap((c) => [...c.body.matchAll(REVIEW_AGAIN_MARKER_RE)].map((m) => ({ head: m[1]!, counted: Number(m[2]) })));
  return restarts.at(-1);
}

export let DECLINED_MARKER_PREFIX = '';

let DECLINED_MARKER_RE = /$^/gi;

/** Names the answer the loop gave to an operator label it did not carry out, and the situation it answered. */
export function renderDeclinedMarker(m: { label: string; key: string }): string {
  return `${DECLINED_MARKER_PREFIX} label=${m.label} key=${m.key} -->`;
}

/** The key of the newest answer given for a label, so the same situation is answered once rather than every pass. */
export function newestDeclinedKey(comments: ReadonlyArray<{ body: string }>, label: string): string | undefined {
  const keys = comments.flatMap((c) => [...c.body.matchAll(DECLINED_MARKER_RE)].filter((m) => m[1] === label).map((m) => m[2]!));
  return keys.at(-1);
}

/** Marks the one-time grace-close warning the loop posts on a merged ticket without the close label. */
export let CLOSE_WARNING_MARKER = '';

/** True when a comment is the loop's: it carries the signature or any marker with the prefix, the queue rules' included. */
export function writtenByLoop(body: string): boolean {
  const said = withoutQuotes(body);
  return said.includes(LOOP_SIGNATURE) || said.includes(`<!-- ${prefix}-`);
}

/**
 * A comment body with its quoted lines removed.
 *
 * GitHub's "Quote reply" copies the comment being answered into the new one,
 * markers and signature and all. Judging authorship on the raw body therefore
 * reads a person's reply to the loop as the loop's own writing, and the reply
 * is the one place an operator is most likely to write an instruction. What a
 * comment quotes is what it answers; what is left is what it says.
 */
function withoutQuotes(body: string): string {
  return body.split('\n').filter((line) => !/^\s*>/.test(line)).join('\n');
}

/* ----------------------------------------------------------- status and faults */

export let STATUS_MARKER = '';

let FAULT_MARKER_RE = /$^/i;

export function renderFaultMarker(fingerprint: string): string {
  return `<!-- ${prefix}-loop-fault fingerprint=${fingerprint} -->`;
}

export function parseFaultMarker(body: string): string | undefined {
  return FAULT_MARKER_RE.exec(body)?.[1];
}

/** Verification evidence on a release pull request, one comment per `main` head. */
export let VERIFICATION_MARKER_PREFIX = '';

export function renderVerificationMarker(head: string): string {
  return `${VERIFICATION_MARKER_PREFIX} head=${head} -->`;
}

export function verificationHeads(body: string): string[] {
  return [...body.matchAll(new RegExp(`<!--\\s*${prefix}-release-verification\\s+head=([0-9a-f]{7,64})\\s*-->`, 'gi'))].map((m) => m[1]!);
}

/* ----------------------------------------------------------------- merged work */

/** Marks the comment the loop posts when it closes a ticket whose work merged. */
export let DONE_MARKER = '';

/**
 * The tickets a pull request says it completes: its `ticket/<n>` branch, and every
 * `Closes #n` / `Fixes #n` / `Resolves #n` (any case, any tense) that starts a line
 * of its body, optionally as a list item. Only a line that leads with the keyword
 * counts, so prose such as "this might fix #12" does not close #12. A reference
 * into another repository (`owner/repo#n`) names no ticket here.
 */
export function ticketsNamedBy(pr: { headRefName: string; body: string }): number[] {
  const out = new Set<number>();
  const branch = /^ticket\/(\d+)$/.exec(pr.headRefName);
  if (branch) out.add(Number(branch[1]));
  for (const m of pr.body.matchAll(/^[ \t]*(?:[-*+][ \t]+)?(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[ \t]+#(\d+)\b/gim)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

/* ----------------------------------------------------------------- the prefix */

/** The name the loop signs claims and commit trailers with: `<prefix>-loop`. */
export const loopName = (): string => `${prefix}-loop`;

/** Point every marker at a repository's prefix. Called when its policy is read; idempotent. */
export function useMarkerPrefix(next: string): void {
  prefix = next;
  const p = escapeRe(next);
  REVIEW_MARKER_PREFIX = `<!-- ${next}-loop-review`;
  REVIEW_MARKER_RE = new RegExp(`<!--\\s*(?:${p}-loop-review|${escapeRe(LEGACY_REVIEW_MARKER_PREFIX)})\\s+([^>]*?)\\s*-->`, 'g');
  FIX_MARKER_PREFIX = `<!-- ${next}-loop-fix`;
  FIX_MARKER_RE = new RegExp(`<!--\\s*${p}-loop-fix\\s+round=(\\d+)\\s+from=([0-9a-f]{7,64})\\s+to=([0-9a-f]{7,64})\\s*-->`, 'gi');
  APPLIED_MARKER_PREFIX = `<!-- ${next}-loop-applied`;
  APPLIED_MARKER_RE = new RegExp(`<!--\\s*${p}-loop-applied\\s+comment=(\\d+)\\s+head=([0-9a-f]{7,64})\\s*-->`, 'gi');
  ACCEPTED_MARKER_PREFIX = `<!-- ${next}-loop-accepted`;
  ACCEPTED_MARKER_RE = new RegExp(`<!--\\s*${p}-loop-accepted\\s+head=([0-9a-f]{7,64})\\s*-->`, 'gi');
  REVIEW_AGAIN_MARKER_PREFIX = `<!-- ${next}-loop-review-again`;
  REVIEW_AGAIN_MARKER_RE = new RegExp(`<!--\\s*${p}-loop-review-again\\s+head=([0-9a-f]{7,64})\\s+counted=(\\d+)\\s*-->`, 'gi');
  DECLINED_MARKER_PREFIX = `<!-- ${next}-loop-declined`;
  DECLINED_MARKER_RE = new RegExp(`<!--\\s*${p}-loop-declined\\s+label=([\\w:-]+)\\s+key=([0-9a-f]{8,64})\\s*-->`, 'gi');
  CLOSE_WARNING_MARKER = `<!-- ${next}-loop-close-warning -->`;
  STATUS_MARKER = `<!-- ${next}-loop-status -->`;
  FAULT_MARKER_RE = new RegExp(`<!--\\s*${p}-loop-fault\\s+fingerprint=([0-9a-f]{16,64})\\s*-->`, 'i');
  VERIFICATION_MARKER_PREFIX = `<!-- ${next}-release-verification`;
  DONE_MARKER = `<!-- ${next}-loop-done -->`;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

useMarkerPrefix(prefix);
