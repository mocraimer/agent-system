import type { Board } from './facts.js';
import { COLUMNS } from './facts.js';
import { countVerdicts, renderVerdictCounts } from './verdicts.js';

/** The board as text, for `agentsys console --print`: every item once, the fact that placed it, and every verdict with its event. */
export function renderBoard(board: Board): string {
  const out: string[] = [];
  const last = board.state.lastPass;
  out.push(`${board.repo}: ${board.state.name}${last ? ` — last pass ${last.id} ended ${last.endedAt} (${last.classification}${last.dryRun ? ', dry run' : ''})` : ''}`);
  out.push(`  ${board.state.because}`);
  if (board.stale) {
    out.push(`  STALE: the latest GitHub read failed at ${board.stale.failedAt}: ${board.stale.error}`);
    out.push(board.snapshotAt
      ? `  Showing the last good snapshot, taken ${board.snapshotAt} (${board.stale.ageSeconds ?? '?'}s old). No verdict is derived from it.`
      : '  There is no earlier snapshot to show.');
  } else if (board.snapshotAt) {
    out.push(`  Store read ${board.snapshotAt}.`);
  }
  const paused = Object.entries(board.paused);
  if (paused.length > 0) out.push(`  Paused: ${paused.map(([stage, p]) => `${stage} (by ${p.by} ${p.at})`).join(', ')}`);
  out.push(`  ${COLUMNS.map((c) => `${c} ${board.counts[c]}`).join(' · ')} · not in play ${board.counts['not in play']}`);

  for (const column of [...COLUMNS, 'not in play' as const]) {
    const items = board.items.filter((i) => i.column === column);
    out.push('', `== ${column} (${items.length})`);
    if (items.length === 0) out.push('   (none)');
    for (const item of items) {
      out.push(`   ${item.ref.padEnd(9)} ${item.title}`);
      out.push(`             because: ${item.because}`);
      if (item.waitsFor) out.push(`             waits for: ${item.waitsFor}; action: ${item.action}`);
    }
  }

  out.push('', `== Verdicts — ${renderVerdictCounts(countVerdicts(board.verdicts))}`);
  if (board.verdicts.length === 0) out.push('   (none)');
  for (const v of board.verdicts) {
    const tag = v.source === 'derived' ? `source: derived${v.superseded ? ' (superseded, kept)' : ''}` : 'source: explicit (current)';
    out.push(`   ${v.cardId}  ${v.item} ${v.stage}: ${v.verdict}  [${tag}]  ${v.detail}`);
  }
  return out.join('\n');
}
