#!/usr/bin/env node
/**
 * Check the committed rung snapshot against its source, and say exactly what moved.
 *
 * Deliberately reports rather than rewrites. The snapshot is a dated reading a
 * person chose to keep; a command that silently overwrote it would hide the one
 * thing worth seeing, which is that the ground moved under a decision already made.
 * Pass `--write` to take a fresh reading once the differences have been read.
 *
 * Exit codes: 0 no change, 1 the snapshot and the source disagree, 2 nothing
 * could be read at all.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  RungParseError, diffRungs, extractRungs, modelsOnPage, parseReachableModels, parseRungTable, parseSourceUrl, renderRungTable, trackedModels,
} from './rungs.js';

const DEFAULT_SNAPSHOT = 'docs/model-effort-rungs.md';

interface Options {
  snapshot: string;
  /** Read the page from a file instead of the network. */
  from?: string;
  write: boolean;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { snapshot: DEFAULT_SNAPSHOT, write: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') options.write = true;
    else if (arg === '--snapshot') options.snapshot = argv[++i] ?? '';
    else if (arg === '--from') options.from = argv[++i] ?? '';
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'refresh-rungs [--snapshot <file>] [--from <saved-page.html>] [--write]\n\n' +
          '  Reads the committed snapshot, fetches the source it names, and reports\n' +
          '  every rung whose score or cost differs. Exit 0 no change, 1 differences,\n' +
          '  2 nothing could be read.',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument "${arg}". Run with --help.`);
      process.exit(2);
    }
  }
  if (options.snapshot === '' || options.from === '') {
    console.error('--snapshot and --from each need a path.');
    process.exit(2);
  }
  return options;
}

async function readPage(options: Options, url: string): Promise<string> {
  if (options.from !== undefined) return readFileSync(options.from, 'utf8');
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new RungParseError(
      `${url} answered ${response.status} ${response.statusText}. Nothing was read, so the ` +
        'committed snapshot stands.',
    );
  }
  return response.text();
}

async function main(argv: string[]): Promise<number> {
  const options = parseOptions(argv);

  let snapshot: string;
  try {
    snapshot = readFileSync(options.snapshot, 'utf8');
  } catch {
    console.error(
      `Could not read the snapshot at ${options.snapshot}. Run from the repository root, or ` +
        'name the file with --snapshot.',
    );
    return 2;
  }

  const committed = parseRungTable(snapshot);
  const url = parseSourceUrl(snapshot);
  const page = await readPage(options, url);
  const live = extractRungs(page, trackedModels(committed));

  // Extraction is filtered to the models the snapshot already names, so a family
  // the source has newly scored cannot appear in `live` and cannot appear in
  // `changes`. Reporting "No change" without this would be true of every rung
  // and still wrong about the page: GPT-5.6 Terra was scored at five rungs and
  // offered by `pi --list-models` while this said "No change. 25 rungs."
  const reachable = parseReachableModels(snapshot);
  const untracked = modelsOnPage(page)
    .filter((m) => reachable.includes(m))
    .filter((m) => !trackedModels(committed).includes(m));

  const changes = diffRungs(committed, live);
  if (changes.length === 0 && untracked.length === 0) {
    console.log(`No change. ${committed.length} rungs in ${options.snapshot} still match ${url}.`);
    return 0;
  }

  if (untracked.length > 0) {
    console.log(
      `${untracked.length} model family(ies) are reachable from here, scored on ${url}, and absent `
      + `from ${options.snapshot}:`,
    );
    for (const model of untracked) console.log(`  ${model}`);
    console.log(
      '\nAdding one is a decision, not a refresh: a tier is only worth tracking if something can '
      + 'dispatch to it. This command will not add them.',
    );
  }

  if (changes.length === 0) {
    console.log(`\nThe ${committed.length} tracked rungs themselves still match ${url}.`);
    return 1;
  }

  console.log(`${changes.length} difference(s) between ${options.snapshot} and ${url}:`);
  for (const change of changes) console.log(`  ${change.rung}: ${change.detail}`);

  if (options.write) {
    const before = renderRungTable(committed);
    const updated = snapshot.replace(before, renderRungTable(live));
    if (updated === snapshot) {
      console.error(
        '\nThe table could not be replaced in place. Update it by hand from the differences above.',
      );
      return 2;
    }
    writeFileSync(options.snapshot, updated, 'utf8');
    console.log(`\nRewrote the table in ${options.snapshot}. Update its "Taken" date and re-read the notes.`);
  } else {
    console.log(
      `\nNothing was written. ${options.snapshot} still holds the older reading above, ` +
        'and is now known to be out of date. Re-run with --write once these differences have been read.',
    );
  }
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof RungParseError) {
      console.error(`RungParseError: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 2;
  });
