/**
 * Structural guards for records read back from disk.
 *
 * `readJson<T>` casts parsed JSON to the requested type, which is sound only if
 * the file really holds that shape. Nothing guarantees it: a record may predate a
 * field, a crash may leave a partial write, or an operator may hand-edit the state
 * directory. Where code then spreads or iterates a field the type promises is an
 * array, the failure is a TypeError far from the cause.
 *
 * These guards are deliberately shallow. They check the fields whose absence
 * actually breaks something — arrays that get spread, identifiers that get
 * compared — rather than validating every leaf, because a guard nobody can read is
 * one nobody maintains.
 */

export class RecordShapeError extends Error {
  override readonly name = 'RecordShapeError';
  constructor(kind: string, path: string, detail: string) {
    super(`Stored ${kind} at ${path} is not usable: ${detail}. It may predate a schema change or have been written by an interrupted run.`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const hasString = (o: Record<string, unknown>, k: string): boolean => typeof o[k] === 'string';
const hasNumber = (o: Record<string, unknown>, k: string): boolean => typeof o[k] === 'number';
const hasArray = (o: Record<string, unknown>, k: string): boolean => Array.isArray(o[k]);

/** Fields each stored kind must carry for the code that reads it not to crash. */
const REQUIRED: Record<string, {
  strings: string[]; numbers: string[]; arrays: string[];
  /**
   * Fields a record may omit, but may not hold a wrong type in. Absence is
   * compatibility — an approval written before the field existed is still good.
   * A present value of the wrong type is corruption, and reaches the reader as
   * an `Approval` whose `model` is a number.
   */
  optionalStrings?: string[];
}> = {
  approval: {
    strings: ['id', 'repo', 'workClass', 'runtime', 'profile'],
    numbers: ['version'],
    arrays: ['actions'],
    optionalStrings: ['model', 'effort'],
  },
  grant: { strings: ['id', 'status'], numbers: ['version'], arrays: ['repos', 'workClasses', 'triggerSources', 'actions', 'runtimes', 'profiles', 'history'] },
  run: { strings: ['id', 'taskId', 'runtime', 'status'], numbers: ['attempt'], arrays: ['actions'] },
  job: { strings: ['id', 'taskId', 'idempotencyKey', 'state'], numbers: [], arrays: ['outstandingObligations', 'artifacts', 'runIds'] },
  reservation: { strings: ['id', 'subscriptionId', 'runId', 'state'], numbers: [], arrays: [] },
  'paid-call': { strings: ['id', 'operation', 'state'], numbers: ['boundUsd'], arrays: [] },
  scorecard: { strings: ['id', 'taskId', 'repo'], numbers: ['attempts'], arrays: ['runIds', 'checks', 'reviewerFindings', 'repairs', 'blockers'] },
  'eval-suite': { strings: ['version', 'oracleDigest'], numbers: [], arrays: ['cases', 'scoring'] },
  'active-version': { strings: ['coordinator', 'activatedBy', 'mergedPr'], numbers: [], arrays: [] },
};

/**
 * Check a stored record has the shape its readers assume.
 *
 * Returns the value unchanged when it is usable, and throws a named error when it
 * is not — a clear failure at the read, rather than an opaque one at first use.
 */
export function checkShape<T>(kind: keyof typeof REQUIRED, path: string, value: unknown): T {
  const spec = REQUIRED[kind as string];
  if (!spec) throw new RecordShapeError(String(kind), path, 'no shape is defined for this kind');
  if (!isObject(value)) throw new RecordShapeError(String(kind), path, 'it is not a JSON object');

  const missing: string[] = [];
  for (const k of spec.strings) if (!hasString(value, k)) missing.push(`${k} (string)`);
  for (const k of spec.numbers) if (!hasNumber(value, k)) missing.push(`${k} (number)`);
  for (const k of spec.arrays) if (!hasArray(value, k)) missing.push(`${k} (array)`);
  for (const k of spec.optionalStrings ?? []) {
    if (value[k] !== undefined && !hasString(value, k)) missing.push(`${k} (string when present)`);
  }

  if (kind === 'scorecard') {
    if (value['reviews'] !== undefined && !hasArray(value, 'reviews')) missing.push('reviews (array)');
    const loop = value['loop'];
    if (loop !== undefined && (!isObject(loop) || !['stage', 'item', 'workType'].every((k) => hasString(loop, k)))) {
      missing.push('loop (stage, item and workType when present)');
    }
    for (const field of ['reviews', 'reviewerFindings']) {
      const entries = value[field];
      if (!Array.isArray(entries)) continue;
      for (const [index, entry] of entries.entries()) {
        if (!usableReview(entry) || (field === 'reviews'
          ? !Number.isInteger(entry['findingCount']) || (entry['findingCount'] as number) < 0
          : !['critical', 'high', 'medium', 'low'].includes(String(entry['severity'])) || !hasString(entry, 'summary'))) {
          missing.push(`${field}[${index}] (attributed review evidence)`);
        }
      }
    }
  }

  if (missing.length > 0) {
    throw new RecordShapeError(String(kind), path, `missing or wrongly typed: ${missing.join(', ')}`);
  }
  return value as T;
}

/** Guard the new nested fields before reports dereference them or claim independence. */
function usableReview(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  if (!['author', 'source', 'at'].every((key) =>
    typeof value[key] === 'string' && (value[key] as string).trim() !== '')) return false;
  // Legacy evidence may have no head or a non-immutable label. Validate full IDs only on new writes.
  if (value['head'] !== undefined && (typeof value['head'] !== 'string' || value['head'].trim() === '')) return false;
  const reviewer = value['reviewer'];
  if (!isObject(reviewer) || typeof reviewer['id'] !== 'string' || reviewer['id'].trim() === '') return false;
  const sameIdentity = (value['author'] as string).trim().toLowerCase() === reviewer['id'].trim().toLowerCase();
  switch (reviewer['relationship']) {
    case 'author': return sameIdentity && reviewer['independent'] === false;
    case 'not-independent': return reviewer['independent'] === false;
    case 'independent': return !sameIdentity && reviewer['independent'] === true;
    default: return false;
  }
}

/** The kinds `checkShape` knows about, exported so tests can enumerate them. */
export const SHAPE_KINDS = Object.keys(REQUIRED);
