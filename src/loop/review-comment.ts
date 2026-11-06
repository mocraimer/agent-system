/**
 * The layout of the loop's review record comment: the verdict first, the review agent's own
 * summary folded away, and what happens next last.
 *
 * `/review-pr` owns the substantive review; its summary is long and its verdict sits in a hidden
 * marker. A person opening the pull request needs the result in one look, so the loop writes the
 * two lines that matter around the summary and folds the summary itself. The hidden marker is not
 * part of this layout and stays where `renderReviewMarker` puts it.
 */

const OPEN = '<details>\n<summary>Full review summary</summary>\n\n';
const CLOSE = '\n\n</details>';

/** A line that is only a `<details>` or `</details>` tag. Left alone inside the summary, it would end the fold early. */
const DETAILS_LINE = /^\s*<\/?details\b[^>]*>\s*$/i;
const ESCAPED_DETAILS_LINE = /^(\s*)&lt;(\/?details\b[^>]*>\s*)$/i;

const neutralise = (text: string): string => text.split('\n').map((line) => (DETAILS_LINE.test(line) ? line.replace('<', '&lt;') : line)).join('\n');
const restore = (text: string): string => text.split('\n').map((line) => line.replace(ESCAPED_DETAILS_LINE, '$1<$2')).join('\n');

export interface ReviewVerdict {
  head: string;
  findings: number;
  independent: boolean;
  reviewer: string;
}

export interface NextInput {
  findings: number;
  independent: boolean;
  /** The loop did not open the pull request, so its author fixes it. */
  outside: boolean;
  draft: boolean;
  human: boolean;
  stopLine: number;
  fixRung: number;
  mergeRung: number;
}

/**
 * Who moves next, by the conditions the fix and merge stages apply. A review comment is written once,
 * so where a later stage might still stop the loop the line says so rather than promising the work.
 */
export function reviewNext(i: NextInput): string {
  if (!i.independent) return 'a re-review by an independent tier once one is reachable. This review does not count toward a merge.';
  if (i.draft || i.human) return `left for a person: this pull request is ${i.draft ? 'a draft' : 'marked HUMAN'}, which the loop does not act on.`;
  if (i.findings === 0) {
    return i.stopLine < i.mergeRung
      ? 'nothing to fix. The ticket\'s stop-line ends before the merge stage, so a person merges.'
      : 'nothing to fix. The merge stage takes it from here, up to the ticket\'s stop-line.';
  }
  if (i.outside) return 'the pull request\'s author fixes the findings. The loop did not open it and does not fix it.';
  if (i.stopLine < i.fixRung) return 'a person fixes the findings. The ticket\'s stop-line ends before the fix stage.';
  return 'the loop\'s fix stage addresses the findings, unless its round cap or a round that makes no progress stops it.';
}

export function renderReviewComment(input: {
  verdict: ReviewVerdict; summary: string; next: string; marker: string; signature: string;
}): string {
  const { verdict: v } = input;
  const top = `**Review of ${v.head}: ${v.findings === 0 ? 'no findings' : `${v.findings} finding${v.findings === 1 ? '' : 's'}`}** · ${v.independent ? 'independent' : 'not independent'} · ${v.reviewer}`;
  return `${top}\n\n${OPEN}${neutralise(input.summary)}${CLOSE}\n\n**Next:** ${input.next}\n\n${input.marker}\n${input.signature}\n`;
}

/**
 * The review agent's summary as it was written, whichever layout the comment has. What the fix stage
 * hands a fixer and what a re-review is given as the previous review must not carry the loop's own
 * verdict, fold or next-step lines.
 */
export function reviewSummary(body: string): string {
  if (!body.includes(OPEN)) return body;
  const start = body.indexOf(OPEN) + OPEN.length;
  const end = body.indexOf(CLOSE, start);
  return end < 0 ? body : restore(body.slice(start, end));
}
