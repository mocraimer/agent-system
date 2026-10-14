/**
 * The model·effort rung table, read from a page and from our own snapshot of it.
 *
 * The source publishes no machine-readable feed — no JSON blocks, no data route —
 * so the numbers come out of rendered HTML. That is fragile by nature, which is
 * why every failure here is loud: a partial parse would quietly replace a good
 * table with a worse one and look like a successful refresh.
 *
 * Nothing read from the page is ever executed or treated as an instruction. Only
 * the five cells of each row are taken, and only as numbers and labels.
 */

export interface RungFigures {
  score: number;
  usd: number;
  /** True where the source marked the figure approximate rather than measured. */
  estimated: boolean;
}

export interface Rung {
  /** The source's own model label, e.g. `GPT-6 Astra`. */
  model: string;
  effort: string;
  /** The "figure it out" lane: planning, deciding, reading a problem. */
  figure: RungFigures;
  /** The "execute it" lane: carrying out work already decided. */
  execute: RungFigures;
}

export class RungParseError extends Error {
  override readonly name = 'RungParseError';
}

/** The source table's header, which is also how the table is found among others. */
export const RUNG_HEADER = [
  'Model · effort', 'Figure', '$ / figure task', 'Execute', '$ / execute task',
] as const;

/** The source marks an approximate figure with this, ahead of the number. */
const APPROX = '≈';

const decode = (s: string): string =>
  s
    .replace(/<!--[\s\S]*?-->/g, '')
    // The source hangs an annotation off some labels — `<details><summary>Missing
    // evidence</summary>…`. It is commentary about the rung, not part of it, and
    // dropping it whole is what keeps "max" from fusing into "maxMissing".
    .replace(/<details[\s\S]*?<\/details>/gi, ' ')
    // A space, not nothing: two values either side of a tag are two values.
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** What the source writes where it has no figure for a rung at all. */
const NO_FIGURE = ['Unscored', 'Unpriced', '—', '-'];

function figures(scoreCell: string, usdCell: string, where: string): RungFigures {
  if (NO_FIGURE.includes(scoreCell) || NO_FIGURE.includes(usdCell)) {
    throw new RungParseError(
      `${where}: the source carries no figures for this rung — it reads "${scoreCell}" and ` +
        `"${usdCell}". This is a gap in the source rather than a changed page, so a snapshot ` +
        'cannot track this model until the source scores it.',
    );
  }
  const estimated = scoreCell.startsWith(APPROX) || usdCell.startsWith(APPROX);
  const scoreText = scoreCell.replace(APPROX, '').trim();
  const usdText = usdCell.replace(APPROX, '').replace('$', '').replace(/,/g, '').trim();
  // `Number('')` is 0, and ` ` and '\n' are 0 too. Without a format to match
  // against, a cell the source left blank became a rung scoring zero at zero
  // dollars — a plausible-looking row that would quietly replace a good one on
  // the next refresh. Match the shape first, then convert.
  const NUMERIC = /^-?\d+(?:\.\d+)?$/;
  if (!NUMERIC.test(scoreText) || !NUMERIC.test(usdText)) {
    throw new RungParseError(
      `${where}: expected a score and a dollar figure, read "${scoreCell}" and "${usdCell}". ` +
        'The source page\'s table has changed shape; re-read it before trusting any refresh.',
    );
  }
  const score = Number(scoreText);
  const usd = Number(usdText);
  return { score, usd, estimated };
}

/**
 * Pull the tracked rungs out of the source page.
 *
 * `tracked` comes from the committed snapshot rather than a list held here, so
 * which models this installation watches is stated once, where a person reads it.
 */
export function extractRungs(html: string, tracked: readonly string[]): Rung[] {
  if (tracked.length === 0) {
    throw new RungParseError('No models to track. The snapshot names which models this table covers.');
  }
  const table = rungTable(html);



  const rows = (table.match(/<tr[\s\S]*?<\/tr>/g) ?? []).slice(1);
  const rungs: Rung[] = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => decode(m[1] ?? ''));
    if (cells.length === 0) continue; // a spacer or grouping row carries no data cells
    if (cells.length !== RUNG_HEADER.length) {
      throw new RungParseError(
        `A row of the rung table has ${cells.length} cells where ${RUNG_HEADER.length} were expected: ` +
          `"${cells.join(' | ').slice(0, 160)}". The page has been restructured.`,
      );
    }
    const label = cells[0]!;
    const model = tracked.find((m) => label.startsWith(`${m} ·`));
    if (!model) continue; // a model this installation cannot dispatch
    const effort = label.slice(model.length + 1).replace('·', '').trim().split(' ')[0] ?? '';
    if (effort === '') {
      throw new RungParseError(`Row "${label}" names a tracked model but no effort.`);
    }
    rungs.push({
      model,
      effort,
      figure: figures(cells[1]!, cells[2]!, `${model} · ${effort} (figure)`),
      execute: figures(cells[3]!, cells[4]!, `${model} · ${effort} (execute)`),
    });
  }

  // Two rows for the same model·effort means the page carries the rung twice and
  // the later read wins by accident. Identity has to be unique for a diff to mean
  // anything.
  const seen = new Set<string>();
  for (const r of rungs) {
    const name = rungName(r);
    if (seen.has(name)) {
      throw new RungParseError(
        `The page's rung table carries ${name} more than once. A duplicated rung makes any ` +
          'difference report depend on which row was read last.',
      );
    }
    seen.add(name);
  }

  const missing = tracked.filter((m) => !rungs.some((r) => r.model === m));
  if (missing.length > 0) {
    throw new RungParseError(
      `The page's rung table carries no row for ${missing.join(', ')}. ` +
        'Either the source dropped the model or the table changed shape; a snapshot written from ' +
        'this read would be missing rows rather than up to date.',
    );
  }
  return rungs;
}


/** The one table on the page carrying the rung header, or a loud failure. */
function rungTable(html: string): string {
  const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? [];
  const matching = tables.filter((t) => {
    const head = (t.match(/<tr[\s\S]*?<\/tr>/) ?? [''])[0];
    const cells = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => decode(m[1] ?? ''));
    return RUNG_HEADER.every((want, i) => cells[i] === want);
  });
  if (matching.length === 0) {
    throw new RungParseError(
      `No table on the page carries the header ${RUNG_HEADER.join(' | ')}. ` +
        `${tables.length} table(s) were found. The page has been restructured; ` +
        'update the extractor rather than refreshing over a good snapshot.',
    );
  }
  // Taking the first match silently picked one of them. With two such tables —
  // one current and one stale, or a second added below — extraction read the
  // wrong one and `diffRungs` then reported no change, which is the worst
  // possible answer: a refresh that says the snapshot is current when it is not.
  if (matching.length > 1) {
    throw new RungParseError(
      `${matching.length} tables on the page carry the header ${RUNG_HEADER.join(' | ')}. ` +
        'Which one is authoritative cannot be decided here, and choosing wrongly would report ' +
        '"no change" against the wrong table. Update the extractor to identify the right one.',
    );
  }
  return matching[0]!;
}

/**
 * Every model family the page scores, whether or not the snapshot tracks it.
 *
 * `extractRungs` is deliberately filtered to the snapshot's own list, which means
 * a family the source newly scores is invisible to it — and a refresh built only
 * on that filter reports "No change" while a whole model family goes untracked.
 * This is what lets the refresh say so instead.
 */
export function modelsOnPage(html: string): string[] {
  const rows = (rungTable(html).match(/<tr[\s\S]*?<\/tr>/g) ?? []).slice(1);
  const families: string[] = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => decode(m[1] ?? ''));
    if (cells.length !== RUNG_HEADER.length) continue;
    const label = cells[0];
    if (label === undefined || label === '') continue;
    // Only families the page actually scores. A row left `Unscored`/`Unpriced`
    // offers nothing to choose between, so reporting it as newly available would
    // be an invitation to track a tier with no figures — which is why Claude
    // Sonnet 5 is absent from the snapshot in the first place.
    try {
      figures(cells[1]!, cells[2]!, label);
      figures(cells[3]!, cells[4]!, label);
    } catch { continue; }
    const family = label.split('·')[0]?.trim();
    if (family !== undefined && family !== '' && !families.includes(family)) families.push(family);
  }
  return families;
}

/**
 * The families something here can actually dispatch to, read from the snapshot.
 *
 * Stated in the document rather than held here because it is a fact about this
 * installation's runtimes, which is what the document is for. Without it a
 * refresh reporting "untracked but scored" names every model on a public
 * leaderboard — twenty-odd families nothing can reach — and the one that matters
 * is lost in the list.
 */
export function parseReachableModels(markdown: string): string[] {
  const found = /^\s*-\s*\*\*Reachable:\*\*\s*(.+)$/m.exec(markdown);
  if (!found?.[1]) {
    throw new RungParseError(
      'The snapshot names no reachable models. It needs a line reading '
      + '`- **Reachable:** <family>, <family>, ...` naming the families this installation can '
      + 'dispatch to, so a refresh can tell a new option apart from a leaderboard entry.',
    );
  }
  return found[1].split(',').map((m) => m.trim()).filter((m) => m !== '');
}

/** How a rung is written in the snapshot and in a difference report. */
export const rungName = (rung: Pick<Rung, 'model' | 'effort'>): string =>
  `${rung.model} · ${rung.effort}`;

const cell = (f: RungFigures, value: number, decimals: number): string =>
  `${f.estimated ? `${APPROX} ` : ''}${value.toFixed(decimals)}`;

/** Render the rungs as the snapshot's markdown table, header included. */
export function renderRungTable(rungs: Rung[]): string {
  const lines = [
    `| ${RUNG_HEADER.join(' | ')} |`,
    '|---|---:|---:|---:|---:|',
  ];
  for (const r of rungs) {
    lines.push(
      `| ${rungName(r)} | ${cell(r.figure, r.figure.score, 2)} | ${cell(r.figure, r.figure.usd, 4).replace(/^(≈ )?/, '$1$$')} ` +
        `| ${cell(r.execute, r.execute.score, 2)} | ${cell(r.execute, r.execute.usd, 4).replace(/^(≈ )?/, '$1$$')} |`,
    );
  }
  return lines.join('\n');
}

/** Read the rungs back out of a committed snapshot. */
export function parseRungTable(markdown: string): Rung[] {
  const header = `| ${RUNG_HEADER.join(' | ')} |`;
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) {
    throw new RungParseError(
      `The snapshot carries no rung table: no line reads "${header}".`,
    );
  }
  const rungs: Rung[] = [];
  for (const line of lines.slice(start + 2)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) break;
    const cells = trimmed.slice(1, trimmed.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim());
    if (cells.length !== RUNG_HEADER.length) {
      throw new RungParseError(`Snapshot row "${trimmed}" has ${cells.length} cells, not ${RUNG_HEADER.length}.`);
    }
    const [model, effort] = cells[0]!.split(' · ');
    if (!model || !effort) {
      throw new RungParseError(`Snapshot row "${trimmed}" does not name a model and an effort.`);
    }
    rungs.push({
      model,
      effort,
      figure: figures(cells[1]!, cells[2]!, `${model} · ${effort} (figure)`),
      execute: figures(cells[3]!, cells[4]!, `${model} · ${effort} (execute)`),
    });
  }
  if (rungs.length === 0) {
    throw new RungParseError('The snapshot\'s rung table has a header and no rows.');
  }
  return rungs;
}

/** The models a snapshot covers, in the order it lists them. */
export function trackedModels(rungs: Rung[]): string[] {
  return [...new Set(rungs.map((r) => r.model))];
}

/** The source URL the snapshot names, so the refresh reads the page it came from. */
export function parseSourceUrl(markdown: string): string {
  const found = /^\s*-\s*\*\*Source:\*\*\s*<(https?:\/\/\S+?)>\s*$/m.exec(markdown);
  if (!found?.[1]) {
    throw new RungParseError(
      'The snapshot names no source. It needs a line reading `- **Source:** <url>` so a refresh ' +
        'reads the page the table came from.',
    );
  }
  return found[1];
}

export interface RungChange {
  rung: string;
  /** What moved, written the way the table writes it. */
  detail: string;
}

/** Every rung whose score or cost differs, plus rungs that appeared or vanished. */
export function diffRungs(committed: Rung[], live: Rung[]): RungChange[] {
  const changes: RungChange[] = [];
  const liveByName = new Map(live.map((r) => [rungName(r), r]));

  for (const was of committed) {
    const name = rungName(was);
    const now = liveByName.get(name);
    if (!now) {
      changes.push({ rung: name, detail: 'no longer on the page' });
      continue;
    }
    for (const lane of ['figure', 'execute'] as const) {
      if (was[lane].score !== now[lane].score) {
        changes.push({ rung: name, detail: `${lane} score ${was[lane].score} → ${now[lane].score}` });
      }
      if (was[lane].usd !== now[lane].usd) {
        changes.push({ rung: name, detail: `${lane} cost $${was[lane].usd} → $${now[lane].usd}` });
      }
      if (was[lane].estimated !== now[lane].estimated) {
        changes.push({
          rung: name,
          detail: `${lane} is now ${now[lane].estimated ? 'estimated' : 'measured'}, was ${was[lane].estimated ? 'estimated' : 'measured'}`,
        });
      }
    }
  }

  const committedNames = new Set(committed.map(rungName));
  for (const now of live) {
    if (!committedNames.has(rungName(now))) {
      changes.push({ rung: rungName(now), detail: 'new on the page' });
    }
  }
  return changes;
}
