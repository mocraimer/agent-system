import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { DEFAULT_POLICY } from '../core/admission.js';
import { CLAUDE_LOCAL_CAPABILITIES } from '../adapters/claude-local.js';
import { CLAUDE_WEB_CAPABILITIES } from '../adapters/claude-web.js';
import { CODEX_CLOUD_CAPABILITIES } from '../adapters/codex-cloud.js';
import { PI_CAPABILITIES } from '../adapters/pi.js';
import { BOOTSTRAP_ALLOWANCE_USD } from '../core/ledger.js';
import { label } from '../core/outcome.js';
import type { OutcomeKind } from '../core/outcome.js';
import { FORBIDDEN_ACTIONS } from '../core/authorize.js';

const run = promisify(execFile);
// dist/cli -> dist -> repo root
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUIDE = readFileSync(join(repoRoot, 'docs', 'OPERATING.md'), 'utf8');
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'main.js');

/**
 * The guide is checked against the code rather than read for plausibility.
 * Documentation drifts silently; a test that fails when a command is renamed or a
 * default changes is the only thing that keeps it true.
 */
describe('the operator guide matches the system it describes', () => {
  const ALL_KINDS: OutcomeKind[] = [
    'completed', 'refused', 'awaiting-approval', 'ready-to-dispatch', 'quota-waiting',
    'attempts-exhausted', 'unsupported-settings', 'setup-blocked', 'remote-uncertain',
    'native-unavailable', 'checks-failed',
  ];

  for (const kind of ALL_KINDS) {
    it(`documents the "${kind}" state under the label the CLI prints`, () => {
      assert.ok(
        GUIDE.includes(label(kind)),
        `"${label(kind)}" is printed to operators but does not appear in the guide`,
      );
    });
  }

  it('documents the narrow manual Pi stop path without claiming task success', () => {
    assert.match(GUIDE, /agentsys resolve-pi --run .*--confirm-stopped/);
    assert.match(GUIDE, /quiesce the original coordinator/);
    assert.match(GUIDE, /descendants that escaped that group/);
    assert.match(GUIDE, /delivery \*\*unverified\*\*/);
    assert.match(GUIDE, /missing retained PID is allowed only with your explicit attestation/);
  });

  it('documents every command the CLI advertises', async () => {
    const { stdout } = await run(process.execPath, [CLI, '--help'], { timeout: 60_000 });
    const commands = stdout
      .split('\n')
      .map((l) => /^ {2}([a-z-]+)\s{2,}/.exec(l)?.[1])
      .filter((c): c is string => typeof c === 'string');
    assert.ok(commands.length >= 10, `expected the CLI to advertise commands, parsed ${commands.length}`);
    const missing = commands.filter((c) => !GUIDE.includes(`agentsys ${c}`));
    assert.deepEqual(missing, [], `commands absent from the guide: ${missing.join(', ')}`);
  });

  it('states the admission defaults the code actually uses', () => {
    assert.match(GUIDE, new RegExp(`${DEFAULT_POLICY.fiveHourThresholdPercent}%[^.]*five-hour`));
    assert.match(GUIDE, new RegExp(`${DEFAULT_POLICY.weeklyThresholdPercent}% of the weekly`));
    assert.match(GUIDE, new RegExp(`${DEFAULT_POLICY.safetyMarginPercent}% margin`));
    assert.match(GUIDE, new RegExp(`${DEFAULT_POLICY.maxReadingAgeSeconds} by`));
  });

  it('says which windows each subscription is metered on, and why', () => {
    // A reader who assumes both windows everywhere would misread a Codex wait.
    assert.match(GUIDE, /Which windows a subscription meters/);
    assert.match(GUIDE, /does not have hourly and has only weekly usage/, 'the operator ruling is the stated basis');
    assert.match(GUIDE, /never read off a usage response/);
    // The two guarantees that keep a narrower declaration from becoming a loophole.
    assert.match(GUIDE, /blocks\*\*, exactly as an\s*\n?unreadable reading does/);
    // The guarantee is now that such a window is checked, not merely recorded.
    assert.match(GUIDE, /which the account reports anyway, is checked too/);
    assert.match(GUIDE, /never licenses admitting past a\s*\n?\s*limit the account is really enforcing/);
    assert.match(GUIDE, /UNDECLARED/, 'the operator is told the declaration is too narrow');
  });

  it('states the paid-call allowance the ledger starts at', () => {
    assert.match(GUIDE, new RegExp(`USD ${BOOTSTRAP_ALLOWANCE_USD}\\b`));
  });

  it('lists each runtime\'s real effort levels', () => {
    for (const level of PI_CAPABILITIES.effortLevels) {
      assert.ok(GUIDE.includes(`\`${level}\``), `Pi effort "${level}" is missing from the guide`);
    }
    for (const level of CLAUDE_WEB_CAPABILITIES.effortLevels) {
      assert.ok(GUIDE.includes(`\`${level}\``), `Claude effort "${level}" is missing from the guide`);
    }
  });

  it('documents the local Claude runtime beside the others', () => {
    assert.match(GUIDE, /\| Local Claude Code \| yes \|/);
    for (const level of CLAUDE_LOCAL_CAPABILITIES.effortLevels) assert.ok(GUIDE.includes(`\`${level}\``));
  });

  it('documents the loop: every pass classification, the merge-dev conditions, and where policy is read from', () => {
    for (const classification of ['idle-empty', 'progress', 'waiting', 'blocked', 'stalled', 'breach']) {
      assert.ok(GUIDE.includes(`| \`${classification}\` |`), `classification ${classification} is not in the guide's table`);
    }
    assert.match(GUIDE, /\*\*`merge-dev`\*\*/);
    assert.match(GUIDE, /stop-line\s+reaches the store configuration's `dev` rung/);
    assert.match(GUIDE, /newest independent review names the current head/);
    assert.match(GUIDE, /findings the operator explicitly accepted at that same head/);
    assert.match(GUIDE, /`check-pr` reports the pull request ready/);
    assert.match(GUIDE, /The coordinator holds no\s+copy/);
    assert.match(GUIDE, /agentsys loop arm --repo/);
    assert.match(GUIDE, /agentsys evaluation --trust --repo/);
  });

  it('does not claim control Codex cloud does not offer', () => {
    assert.equal(CODEX_CLOUD_CAPABILITIES.supportsModelSelection, false);
    assert.equal(CODEX_CLOUD_CAPABILITIES.supportsEffortSelection, false);
    assert.match(GUIDE, /no model and no effort/);
    assert.match(GUIDE, /`unknown`/, 'the guide must say the effective settings are unknown');
  });

  it('names the actions no authority can permit', () => {
    for (const action of FORBIDDEN_ACTIONS) {
      const word = action.replace('-', ' ').replace('deploy prod', 'production');
      assert.ok(
        GUIDE.toLowerCase().includes(word.toLowerCase()) || GUIDE.includes(action),
        `forbidden action "${action}" is not mentioned in the guide`,
      );
    }
  });

  it('says the shipped configuration has no active grants', () => {
    assert.match(GUIDE, /no active grants/);
  });

  it('describes the check deferral mechanism', () => {
    // The guide must explain that a deferred check is not passed, so an operator
    // does not read a deferral as implicit coverage.
    assert.match(GUIDE, /A deferred check does not block acceptance/);
    assert.match(GUIDE, /never reported as passed/);
    assert.match(GUIDE, /reports as deferred/);
    assert.match(GUIDE, /agentsys checks --defer/);
    assert.match(GUIDE, /agentsys checks --restore/);
  });

  it('keeps the unknowns explicit rather than generalising them', () => {
    assert.match(GUIDE, /has not been established/, 'the shared-subscription assumption stays flagged');
    // Both cloud-creation paths have since been tried against the real CLI and both
    // refuse, so the guide must now quote the refusals instead of calling them open.
    assert.doesNotMatch(GUIDE, /has not been tested here/, 'the cloud-creation path is settled, not open');
    assert.match(GUIDE, /--cloud requires an interactive terminal/);
    assert.match(GUIDE, /different backends/);
    // The consequence an operator has to plan around: a cloud dispatch never lands
    // as `completed` by itself, so the guide must not leave that as a surprise.
    assert.match(GUIDE, /`remote-uncertain`, not\s+`completed`/);
  });
});
