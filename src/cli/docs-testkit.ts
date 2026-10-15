/**
 * Markdown helpers shared by the tests that check the README, the agent runbook, the
 * reader-task list and the explainer page against the code they describe.
 *
 * Fenced blocks are read in one place (`markdownLines`), so every helper agrees on what
 * is code and what is prose.
 */

/** The program names a documented command starts with, and the whitespace that follows. */
export const CLI_PREFIX = /^(?:agentsys|node dist\/cli\/main\.js)\s+/;

export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One line of a Markdown document. */
export interface MdLine {
  text: string;
  /** The line is a ``` marker, opening or closing a block. */
  fence: boolean;
  /** Which fenced block the line is inside (0 for the first), or undefined for prose and markers. */
  block: number | undefined;
}

/** Splits a document into lines and marks the fenced blocks. A fence opens or closes a block when it is indented by at most three spaces, as in CommonMark. */
export function markdownLines(md: string): MdLine[] {
  const out: MdLine[] = [];
  let block = -1;
  let open = false;
  for (const text of md.split('\n')) {
    if (/^ {0,3}```/.test(text)) {
      if (!open) block++;
      open = !open;
      out.push({ text, fence: true, block: undefined });
    } else {
      out.push({ text, fence: false, block: open ? block : undefined });
    }
  }
  if (open) throw new Error('the document ends inside a fenced block: a closing ``` is missing');
  return out;
}

/** The lines inside each fenced code block. */
export function fencedBlocks(md: string): string[][] {
  const blocks: string[][] = [];
  for (const { text, block } of markdownLines(md)) {
    if (block !== undefined) (blocks[block] ??= []).push(text);
  }
  return Array.from(blocks, (b) => b ?? []);
}

/** The prose of a document: no fenced blocks, no inline code spans. */
export function proseOf(md: string): string {
  return markdownLines(md)
    .filter((l) => !l.fence && l.block === undefined)
    .map((l) => l.text.replace(/`[^`]*`/g, ''))
    .join('\n');
}

/** The line without a trailing shell comment: a `#` that follows whitespace, outside any quotes. */
export function withoutComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && i > 0 && /\s/.test(line[i - 1]!) && (i + 1 === line.length || /\s/.test(line[i + 1]!))) return line.slice(0, i).trimEnd();
  }
  return line.trim();
}

/** One logical line of a document: a fenced line, with backslash continuations joined, or a prose line. */
export interface Logical { text: string; fenced: boolean }

export function logicalLines(md: string): Logical[] {
  const lines = markdownLines(md);
  const out: Logical[] = [];
  for (let i = 0; i < lines.length; i++) {
    const { text, fence, block } = lines[i]!;
    if (fence) continue;
    if (block === undefined) { out.push({ text, fenced: false }); continue; }
    let line = text.trim();
    while (line.endsWith('\\') && lines[i + 1]?.block === block) {
      line = `${line.slice(0, -1).trimEnd()} ${lines[++i]!.text.trim()}`;
    }
    out.push({ text: withoutComment(line), fenced: true });
  }
  return out;
}

/**
 * Every `agentsys ...` or `node dist/cli/main.js ...` command in a document, in order: lines
 * in fenced blocks (continuations joined, trailing comments dropped) and, unless `fencedOnly`,
 * inline code spans in prose. A span that does not start with the program name, such as
 * `approve --task`, is not one. A fenced line is a whole command; an inline span may name only
 * part of one, so only fenced lines are candidates to run.
 */
export function commandLines(md: string, fencedOnly = false): string[] {
  const out: string[] = [];
  for (const { text, fenced } of logicalLines(md)) {
    if (fenced) {
      if (CLI_PREFIX.test(text)) out.push(text);
    } else if (!fencedOnly) {
      for (const m of text.matchAll(/`([^`]+)`/g)) if (CLI_PREFIX.test(m[1]!.trim())) out.push(m[1]!.trim());
    }
  }
  return out;
}

/** Every command line in the fenced blocks of a document, whatever program it runs. */
export function shellLines(md: string): string[] {
  return logicalLines(md).filter((l) => l.fenced && l.text !== '' && !l.text.startsWith('#')).map((l) => l.text);
}

/** The text under the first heading whose title matches, up to the next heading of the same or higher level. */
export function sectionOf(md: string, title: RegExp): string | undefined {
  let level = 0;
  const body: string[] = [];
  for (const { text, fence, block } of markdownLines(md)) {
    const heading = fence || block !== undefined ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
    if (level === 0) {
      if (heading && title.test(heading[2]!)) level = heading[1]!.length;
    } else if (heading && heading[1]!.length <= level) {
      break;
    } else {
      body.push(text);
    }
  }
  return level === 0 ? undefined : body.join('\n');
}

/** GitHub's anchor for each heading: lower case, punctuation removed, spaces to hyphens, repeats suffixed. */
export function headingSlugs(md: string): Set<string> {
  const slugs = new Set<string>();
  const seen = new Map<string, number>();
  for (const { text, fence, block } of markdownLines(md)) {
    const m = fence || block !== undefined ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(text);
    if (!m) continue;
    const slug = m[1]!.toLowerCase().replace(/<[^>]+>/g, '').replace(/`/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    slugs.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return slugs;
}
