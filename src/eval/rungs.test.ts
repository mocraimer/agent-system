import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  diffRungs, extractRungs, modelsOnPage, parseReachableModels, parseRungTable, parseSourceUrl, renderRungTable,
  RungParseError, RUNG_HEADER, trackedModels,
} from './rungs.js';
import type { Rung } from './rungs.js';

/** The source's real row shape, including the comment nodes its renderer emits. */
function row(label: string, cells: readonly string[]): string {
  return `<tr><td class="px-3 py-1.5">${label}</td>${
    cells.map((c) => `<td class="text-right px-3 py-1.5 tabular-nums">${c}</td>`).join('')
  }</tr>`;
}

function page(rows: string, header: readonly string[] = RUNG_HEADER): string {
  return [
    '<html><body>',
    '<table><tr><th>Benchmark</th><th>Native result</th></tr><tr><td>HLE</td><td>59.13</td></tr></table>',
    `<table><tr>${header.map((h) => `<th class="x">${h}</th>`).join('')}</tr>`,
    rows,
    '</table></body></html>',
  ].join('\n');
}

const TRACKED = ['GPT-6 Astra', 'GPT-5.6 Luna'];
const REAL_ROWS = [
  row('GPT-6 Astra<!-- --> · <!-- -->max', ['70.77', '$4.1291', '63.96', '$8.3690']),
  row('Claude Fable 5.1<!-- --> · <!-- -->max<span> Missing evidence</span>', ['76.29', '$9.6412', '&#8776; 64.18', '&#8776; $14.1906']),
  row('GPT-5.6 Luna<!-- --> · <!-- -->max', ['55.65', '$0.1676', '42.50', '$1.3882']),
].join('\n');

describe('reading rungs off the source page', () => {
  it('keeps only the models this installation tracks', () => {
    const rungs = extractRungs(page(REAL_ROWS), TRACKED);
    assert.deepEqual(rungs.map((r) => `${r.model} · ${r.effort}`), [
      'GPT-6 Astra · max', 'GPT-5.6 Luna · max',
    ]);
  });

  it('reads both lanes apart rather than blending them', () => {
    const [astra] = extractRungs(page(REAL_ROWS), TRACKED);
    assert.deepEqual(astra?.figure, { score: 70.77, usd: 4.1291, estimated: false });
    assert.deepEqual(astra?.execute, { score: 63.96, usd: 8.369, estimated: false });
  });

  it('marks a figure the source called approximate as estimated', () => {
    const rungs = extractRungs(page(REAL_ROWS), ['Claude Fable 5.1']);
    assert.equal(rungs[0]?.figure.estimated, false);
    assert.equal(rungs[0]?.execute.estimated, true);
    assert.equal(rungs[0]?.execute.score, 64.18);
  });

  it('refuses a page whose table it cannot find, rather than returning nothing', () => {
    assert.throws(
      () => extractRungs(page(REAL_ROWS, ['Configuration', 'Quality', 'Price']), TRACKED),
      (err: unknown) => {
        assert.ok(err instanceof RungParseError);
        assert.match(err.message, /No table on the page carries the header/);
        return true;
      },
    );
  });

  it('refuses a page that lost a tracked model, rather than returning the rest', () => {
    const withoutLuna = row('GPT-6 Astra<!-- --> · <!-- -->max', ['70.77', '$4.1291', '63.96', '$8.3690']);
    assert.throws(
      () => extractRungs(page(withoutLuna), TRACKED),
      (err: unknown) => {
        assert.ok(err instanceof RungParseError);
        assert.match(err.message, /carries no row for GPT-5\.6 Luna/);
        return true;
      },
    );
  });

  it('refuses a row whose cells stopped being numbers', () => {
    const wordy = row('GPT-6 Astra<!-- --> · <!-- -->max', ['n/a', '$4.1291', '63.96', '$8.3690'])
      + '\n' + row('GPT-5.6 Luna<!-- --> · <!-- -->max', ['55.65', '$0.1676', '42.50', '$1.3882']);
    assert.throws(
      () => extractRungs(page(wordy), TRACKED),
      (err: unknown) => {
        assert.ok(err instanceof RungParseError);
        assert.match(err.message, /expected a score and a dollar figure/);
        return true;
      },
    );
  });

  it('refuses a row that gained or lost a column', () => {
    const short = row('GPT-6 Astra<!-- --> · <!-- -->max', ['70.77', '$4.1291', '63.96']);
    assert.throws(() => extractRungs(page(short), TRACKED), RungParseError);
  });

  // The source hangs a `<details>` annotation off some labels. Stripping tags
  // without a separator fused the effort into it — "max" became "maxMissing" —
  // which is a silent partial parse wearing a different coat.
  it('reads the effort off a label carrying an annotation', () => {
    const annotated = row(
      'GPT-6 Astra<!-- --> · <!-- -->max<details class="x"><summary>Missing evidence</summary>'
      + '<ul><li>Execute<!-- --> · <!-- -->some benchmark<!-- -->: <!-- -->no matching measurement</li></ul></details>',
      ['70.77', '$4.1291', '63.96', '$8.3690'],
    ) + '\n' + row('GPT-5.6 Luna<!-- --> · <!-- -->max', ['55.65', '$0.1676', '42.50', '$1.3882']);
    const rungs = extractRungs(page(annotated), TRACKED);
    assert.deepEqual(rungs.map((r) => `${r.model} · ${r.effort}`), [
      'GPT-6 Astra · max', 'GPT-5.6 Luna · max',
    ]);
  });

  // `Number('')` is 0, so a blank cell used to become a rung scoring zero at zero
  // dollars — a plausible row that would replace a good one on the next refresh.
  it('refuses a blank cell rather than reading it as zero', () => {
    for (const cells of [
      ['', '$4.1291', '63.96', '$8.3690'],
      ['70.77', '', '63.96', '$8.3690'],
      ['70.77', '$4.1291', ' ', '$8.3690'],
      ['70.77', '$4.1291', '63.96', '$'],
    ]) {
      const blanked = row('GPT-6 Astra<!-- --> · <!-- -->max', cells)
        + '\n' + row('GPT-5.6 Luna<!-- --> · <!-- -->max', ['55.65', '$0.1676', '42.50', '$1.3882']);
      assert.throws(
        () => extractRungs(page(blanked), TRACKED),
        (err: unknown) => {
          assert.ok(err instanceof RungParseError);
          assert.match(err.message, /expected a score and a dollar figure/);
          return true;
        },
        `cells ${JSON.stringify(cells)} should be refused`,
      );
    }
  });

  it('refuses a cell that is not a number at all, however it is spelled', () => {
    for (const bad of ['12.3.4', '1e5', '--7', '7%', 'NaN', 'Infinity']) {
      const wrong = row('GPT-6 Astra<!-- --> · <!-- -->max', [bad, '$4.1291', '63.96', '$8.3690'])
        + '\n' + row('GPT-5.6 Luna<!-- --> · <!-- -->max', ['55.65', '$0.1676', '42.50', '$1.3882']);
      assert.throws(() => extractRungs(page(wrong), TRACKED), RungParseError, `"${bad}" should be refused`);
    }
  });

  // Choosing the first match meant a page with a stale copy of the table could be
  // read from the wrong one, and diffRungs would then report "no change" — a
  // refresh claiming the snapshot is current when it is not.
  it('refuses a page carrying two tables with the rung header', () => {
    const one = page(REAL_ROWS);
    const two = one.replace('</body></html>', '') + '\n' + one.slice(one.indexOf('<table><tr><th class'));
    assert.throws(
      () => extractRungs(two, TRACKED),
      (err: unknown) => {
        assert.ok(err instanceof RungParseError);
        assert.match(err.message, /carry the header/);
        assert.match(err.message, /cannot be decided here/);
        return true;
      },
    );
  });

  it('refuses a table that carries the same rung twice', () => {
    const twice = REAL_ROWS + '\n' + row('GPT-6 Astra<!-- --> · <!-- -->max', ['1.00', '$1.0000', '2.00', '$2.0000']);
    assert.throws(
      () => extractRungs(page(twice), TRACKED),
      (err: unknown) => {
        assert.ok(err instanceof RungParseError);
        assert.match(err.message, /more than once/);
        return true;
      },
    );
  });

  it('refuses a rung the source left without figures, and says that is what happened', () => {
    const unscored = row('GPT-6 Astra<!-- --> · <!-- -->high', ['Unscored', 'Unpriced', 'Unscored', 'Unpriced'])
      + '\n' + row('GPT-5.6 Luna<!-- --> · <!-- -->max', ['55.65', '$0.1676', '42.50', '$1.3882']);
    assert.throws(
      () => extractRungs(page(unscored), TRACKED),
      (err: unknown) => {
        assert.ok(err instanceof RungParseError);
        assert.match(err.message, /carries no figures for this rung/);
        assert.match(err.message, /gap in the source rather than a changed page/);
        return true;
      },
    );
  });
});

/**
 * `extractRungs` is filtered to the snapshot's own models, so it cannot see a
 * family the source has newly scored. A refresh built only on it reports "No
 * change" while a whole family goes untracked — which is what happened with
 * GPT-5.6 Terra: five scored rungs on the page, offered by `pi --list-models`,
 * and the refresh said "No change. 25 rungs."
 */
describe('what the page scores, regardless of what is tracked', () => {
  it('names every family on the page, including untracked ones', () => {
    assert.deepEqual(modelsOnPage(page(REAL_ROWS)), ['GPT-6 Astra', 'Claude Fable 5.1', 'GPT-5.6 Luna']);
  });

  it('names a family once however many rungs it has', () => {
    const many = REAL_ROWS
      + '\n' + row('GPT-6 Astra<!-- --> · <!-- -->high', ['68.97', '$2.2015', '61.50', '$4.0281'])
      + '\n' + row('GPT-6 Astra<!-- --> · <!-- -->low', ['63.10', '$0.8643', '53.24', '$1.8239']);
    assert.deepEqual(modelsOnPage(page(many)).filter((m) => m === 'GPT-6 Astra'), ['GPT-6 Astra']);
  });

  // A rung with no figures offers nothing to choose between, so naming it as a
  // newly available option would invite tracking a tier the source cannot rank.
  it('passes over a family the source scores nowhere', () => {
    const unscored = REAL_ROWS
      + '\n' + row('Claude Sonnet 5<!-- --> · <!-- -->high', ['Unscored', 'Unpriced', 'Unscored', 'Unpriced']);
    assert.ok(!modelsOnPage(page(unscored)).includes('Claude Sonnet 5'));
  });

  it('keeps a family that is scored at one rung and unscored at another', () => {
    const mixed = REAL_ROWS
      + '\n' + row('Claude Sonnet 5<!-- --> · <!-- -->high', ['Unscored', 'Unpriced', 'Unscored', 'Unpriced'])
      + '\n' + row('Claude Sonnet 5<!-- --> · <!-- -->max', ['60.32', '$5.8908', '37.46', '$17.1738']);
    assert.ok(modelsOnPage(page(mixed)).includes('Claude Sonnet 5'));
  });

  it('surfaces a family no snapshot tracks, which extraction cannot', () => {
    const withTerra = REAL_ROWS
      + '\n' + row('GPT-5.6 Terra<!-- --> · <!-- -->max', ['61.20', '$1.1000', '52.40', '$2.2000']);
    assert.ok(modelsOnPage(page(withTerra)).includes('GPT-5.6 Terra'));
    // Extraction, filtered to the tracked list, is blind to it.
    assert.ok(!extractRungs(page(withTerra), TRACKED).some((r) => r.model === 'GPT-5.6 Terra'));
  });
});

describe('the committed snapshot', () => {
  const RUNGS: Rung[] = [
    { model: 'GPT-6 Astra', effort: 'max', figure: { score: 70.77, usd: 4.1291, estimated: false }, execute: { score: 63.96, usd: 8.369, estimated: false } },
    { model: 'GPT-5.6 Luna', effort: 'max', figure: { score: 55.65, usd: 0.1676, estimated: false }, execute: { score: 42.5, usd: 1.3882, estimated: true } },
  ];

  it('survives a round trip through its own table', () => {
    assert.deepEqual(parseRungTable(renderRungTable(RUNGS)), RUNGS);
  });

  it('names the models it covers, so nothing holds a second list', () => {
    assert.deepEqual(trackedModels(RUNGS), ['GPT-6 Astra', 'GPT-5.6 Luna']);
  });

  it('reads back the source it came from', () => {
    const doc = 'Intro\n\n- **Source:** <https://example.test/rungs/>\n- **Taken:** 2026-09-13\n';
    assert.equal(parseSourceUrl(doc), 'https://example.test/rungs/');
  });

  it('reads the families this installation can dispatch to', () => {
    const doc = '- **Taken:** 2026-09-13\n- **Reachable:** GPT-6 Astra, GPT-5.6 Terra , Claude Opus 5\n';
    assert.deepEqual(parseReachableModels(doc), ['GPT-6 Astra', 'GPT-5.6 Terra', 'Claude Opus 5']);
  });

  // Without it the refresh names every family on a public leaderboard, and the
  // one that can actually be dispatched to is lost among twenty that cannot.
  it('refuses a snapshot that declares no reachable models', () => {
    assert.throws(() => parseReachableModels('- **Taken:** 2026-09-13\n'), (err: unknown) => {
      assert.ok(err instanceof RungParseError);
      assert.match(err.message, /names no reachable models/);
      return true;
    });
  });

  it('refuses to refresh a snapshot that names no source', () => {
    assert.throws(() => parseSourceUrl('- **Taken:** 2026-09-13\n'), (err: unknown) => {
      assert.ok(err instanceof RungParseError);
      assert.match(err.message, /names no source/);
      return true;
    });
  });

  it('refuses a document with no rung table at all', () => {
    assert.throws(() => parseRungTable('# Notes\n\nnothing here\n'), RungParseError);
  });

  it('refuses a table with a header and no rows', () => {
    assert.throws(
      () => parseRungTable(`| ${RUNG_HEADER.join(' | ')} |\n|---|---:|---:|---:|---:|\n\ntext\n`),
      (err: unknown) => {
        assert.ok(err instanceof RungParseError);
        assert.match(err.message, /header and no rows/);
        return true;
      },
    );
  });
});

describe('what moved since the snapshot', () => {
  const was: Rung[] = [
    { model: 'GPT-5.6 Luna', effort: 'max', figure: { score: 55.65, usd: 0.1676, estimated: false }, execute: { score: 42.5, usd: 1.3882, estimated: false } },
  ];

  it('reports nothing when the source still agrees', () => {
    assert.deepEqual(diffRungs(was, structuredClone(was)), []);
  });

  it('names the rung, the lane and both figures when a score moves', () => {
    const now = structuredClone(was);
    now[0]!.figure.score = 58.1;
    assert.deepEqual(diffRungs(was, now), [
      { rung: 'GPT-5.6 Luna · max', detail: 'figure score 55.65 → 58.1' },
    ]);
  });

  it('reports a cost move separately from a score move', () => {
    const now = structuredClone(was);
    now[0]!.execute.usd = 1.5;
    assert.deepEqual(diffRungs(was, now), [
      { rung: 'GPT-5.6 Luna · max', detail: 'execute cost $1.3882 → $1.5' },
    ]);
  });

  it('reports a figure that stopped being measured', () => {
    const now = structuredClone(was);
    now[0]!.execute.estimated = true;
    assert.deepEqual(diffRungs(was, now), [
      { rung: 'GPT-5.6 Luna · max', detail: 'execute is now estimated, was measured' },
    ]);
  });

  it('reports a rung that appeared and one that vanished', () => {
    const now: Rung[] = [
      { model: 'GPT-5.6 Luna', effort: 'xhigh', figure: { score: 53.01, usd: 0.0929, estimated: false }, execute: { score: 34.68, usd: 0.6642, estimated: false } },
    ];
    assert.deepEqual(diffRungs(was, now), [
      { rung: 'GPT-5.6 Luna · max', detail: 'no longer on the page' },
      { rung: 'GPT-5.6 Luna · xhigh', detail: 'new on the page' },
    ]);
  });
});
