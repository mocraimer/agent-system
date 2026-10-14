import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flag, list, optionalNumber, parseArgs, requireString, UsageError } from './args.js';

describe('flag parsing', () => {
  it('splits the subcommand path from the flags', () => {
    const { command, flags } = parseArgs(['grant', 'create', '--repos', 'a/b']);
    assert.deepEqual(command, ['grant', 'create']);
    assert.equal(flags.get('repos'), 'a/b');
  });

  it('accepts --name=value', () => {
    const { flags } = parseArgs(['x', '--repo=a/b']);
    assert.equal(flags.get('repo'), 'a/b');
  });

  it('treats a flag with no value as a boolean', () => {
    const { flags } = parseArgs(['x', '--yes', '--repo', 'a/b']);
    assert.equal(flags.get('yes'), true);
    assert.equal(flag(flags, 'yes'), true);
  });

  it('reports a missing required flag as usage, not a crash', () => {
    const { flags } = parseArgs(['x']);
    assert.throws(() => requireString(flags, 'repo'), UsageError);
  });

  it('rejects a non-numeric number rather than coercing it to NaN', () => {
    const { flags } = parseArgs(['x', '--limit', 'lots']);
    assert.throws(() => optionalNumber(flags, 'limit'), /must be a number/);
  });

  it('splits comma lists and drops empty entries', () => {
    const { flags } = parseArgs(['x', '--actions', 'author-changes, open-pr ,']);
    assert.deepEqual(list(flags, 'actions'), ['author-changes', 'open-pr']);
  });

  it('returns an empty list rather than [""] for an absent flag', () => {
    const { flags } = parseArgs(['x']);
    assert.deepEqual(list(flags, 'actions'), []);
  });
});
