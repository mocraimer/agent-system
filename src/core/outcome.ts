/**
 * The states an operator must be able to tell apart (INV-G30).
 *
 * Every operator-visible surface renders one of these. A generic "failed" is not
 * a member of this union on purpose: an operator seeing `failed` learns nothing
 * about whether to wait, approve something, fix setup, or read a test report.
 */
export type OutcomeKind =
  | 'completed'
  | 'refused'
  | 'awaiting-approval'
  | 'ready-to-dispatch'
  | 'quota-waiting'
  | 'attempts-exhausted'
  | 'unsupported-settings'
  | 'setup-blocked'
  | 'remote-uncertain'
  | 'native-unavailable'
  | 'checks-failed';

/** Human-facing label per kind. Kept beside the union so a new kind cannot ship unlabelled. */
const LABELS: Record<OutcomeKind, string> = {
  completed: 'Completed',
  refused: 'Refused',
  'awaiting-approval': 'Awaiting approval',
  'ready-to-dispatch': 'Authorized, ready to dispatch',
  'quota-waiting': 'Waiting on subscription allowance',
  'attempts-exhausted': 'Attempt limit reached',
  'unsupported-settings': 'Unsupported model/effort settings',
  'setup-blocked': 'Setup incomplete',
  'remote-uncertain': 'Remote state uncertain',
  'native-unavailable': 'Native runner unavailable',
  'checks-failed': 'No confirmed success',
};

/**
 * An outcome an operator can act on.
 *
 * `nextAction` is required rather than optional: the gate this type serves says a
 * message must name "the next valid action", so a caller that has nothing useful
 * to say is forced to notice at compile time rather than emit a dead end.
 */
export interface Outcome {
  kind: OutcomeKind;
  /** Task this concerns, when one exists. Absent only before a task is created. */
  taskId?: string;
  /** Run this concerns, when a run had been dispatched. */
  runId?: string;
  /** What happened, in the operator's terms. No stack traces. */
  summary: string;
  /** The next valid action, phrased as something the operator can actually do. */
  nextAction: string;
  /** Proven before the task prompt was sent. Absent means unknown, not false. */
  promptNotSent?: true;
  /** Supporting facts: quota readings, check names, session ids. Never credentials. */
  details?: Record<string, unknown>;
}

export function label(kind: OutcomeKind): string {
  return LABELS[kind];
}

/** True when the outcome leaves work outstanding that something later must resolve. */
export function isOutstanding(kind: OutcomeKind): boolean {
  return (
    kind === 'awaiting-approval' ||
    kind === 'quota-waiting' ||
    kind === 'remote-uncertain' ||
    kind === 'native-unavailable' ||
    kind === 'setup-blocked'
  );
}

/**
 * Render an outcome for a terminal. Two lines: what happened, then what to do.
 * Deliberately not a progress bar or a percentage — elapsed facts only.
 */
export function render(o: Outcome): string {
  const scope = [o.taskId && `task ${o.taskId}`, o.runId && `run ${o.runId}`]
    .filter(Boolean)
    .join(', ');
  const head = scope ? `${label(o.kind)} (${scope})` : label(o.kind);
  const lines = [`${head}: ${o.summary}`, `  Next: ${o.nextAction}`];
  if (o.details && Object.keys(o.details).length > 0) {
    for (const [k, v] of Object.entries(o.details)) {
      lines.push(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  }
  return lines.join('\n');
}
