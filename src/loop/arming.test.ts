import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * Arming, disarming and status, driven through the built `agentsys` the way an
 * operator drives them, with `systemctl` stubbed so nothing touches a real user
 * service. The stub records every call and can be told to refuse one.
 */

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'main.js');

describe('arming a loop for each repository on one installation', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentsys-arming-'));
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'state'));
    mkdirSync(join(dir, 'home'));
    // Records `systemctl --user <args>`; REFUSE names a verb and unit whose call fails with a message on stderr.
    writeFileSync(join(dir, 'bin', 'systemctl'), [
      '#!/bin/sh',
      'shift',
      `echo "$*" >> ${JSON.stringify(join(dir, 'systemctl.log'))}`,
      'if [ -n "$REFUSE" ] && echo "$*" | grep -q -- "$REFUSE"; then echo "Failed to connect to bus: No medium found" >&2; exit 1; fi',
      'if [ "$1" = "is-active" ]; then echo active; fi',
      'exit 0',
    ].join('\n'));
    chmodSync(join(dir, 'bin', 'systemctl'), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const repo = (name: string): string => {
    const path = join(dir, name);
    execFileSync('git', ['init', '--quiet', path]);
    execFileSync('git', ['-C', path, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`]);
    return path;
  };
  const cli = (args: string[], env: Record<string, string> = {}) => {
    const done = spawnSync(process.execPath, [MAIN, ...args], {
      encoding: 'utf8',
      env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, HOME: join(dir, 'home'), AGENTSYS_STATE: join(dir, 'state'), ...env },
    });
    return { code: done.status, out: done.stdout, err: done.stderr, text: `${done.stdout}${done.stderr}` };
  };
  const calls = (): string[] => (existsSync(join(dir, 'systemctl.log')) ? readFileSync(join(dir, 'systemctl.log'), 'utf8').trim().split('\n') : []);
  const unitFile = (unit: string): string => join(dir, 'home', '.config', 'systemd', 'user', unit);
  const record = (slugDir: string): string => join(dir, 'state', 'loop', slugDir, 'armed.json');

  it('arms a second repository without touching the first', () => {
    const a = repo('widgets');
    const b = repo('gadgets');
    assert.equal(cli(['loop', 'arm', '--repo', a, '--interval', '900']).code, 0);
    const recordA = readFileSync(record('acme_widgets'), 'utf8');
    const unitA = readFileSync(unitFile('agentsys-loop-acme_widgets.service'), 'utf8');
    const callsAfterA = calls().length;

    const second = cli(['loop', 'arm', '--repo', b, '--interval', '1200', '--policy-ref', 'origin/feature']);
    assert.equal(second.code, 0, second.text);
    assert.equal(readFileSync(record('acme_widgets'), 'utf8'), recordA, 'the first repository\'s record is untouched');
    assert.equal(readFileSync(unitFile('agentsys-loop-acme_widgets.service'), 'utf8'), unitA, 'and so is its unit');
    const mine = calls().slice(callsAfterA);
    assert.ok(mine.every((c) => !c.includes('acme_widgets')), `arming the second repository named only its own unit:\n${mine.join('\n')}`);
    assert.ok(mine.includes('enable --now agentsys-loop-acme_gadgets.service'));

    const recordB = JSON.parse(readFileSync(record('acme_gadgets'), 'utf8')) as Record<string, unknown>;
    assert.equal(recordB['intervalSeconds'], 1200);
    assert.equal(recordB['policyRef'], 'origin/feature');
    assert.equal(recordB['slug'], 'acme/gadgets');
  });

  it('gives every loop the one state directory, so there is one ledger', () => {
    cli(['loop', 'arm', '--repo', repo('widgets')]);
    cli(['loop', 'arm', '--repo', repo('gadgets')]);
    const state = (unit: string): string | undefined => /^Environment=AGENTSYS_STATE=(.*)$/m.exec(readFileSync(unitFile(unit), 'utf8'))?.[1];
    assert.equal(state('agentsys-loop-acme_widgets.service'), join(dir, 'state'));
    assert.equal(state('agentsys-loop-acme_gadgets.service'), join(dir, 'state'));
    assert.match(readFileSync(unitFile('agentsys-loop-acme_gadgets.service'), 'utf8'), /ExecStart=.* loop --armed --slug acme\/gadgets$/m);
  });

  it('shows each armed repository, its service and its last pass', () => {
    cli(['loop', 'arm', '--repo', repo('widgets')]);
    cli(['loop', 'arm', '--repo', repo('gadgets')]);
    writeFileSync(join(dir, 'state', 'loop', 'acme_widgets', 'state.json'), JSON.stringify({
      repo: 'acme/widgets', lastPass: { passId: 'pass_7', endedAt: '2026-11-17T10:00:00.000Z', classification: 'waiting', because: 'the review window resets at 14:00' },
    }));
    const status = cli(['loop', 'status']);
    assert.equal(status.code, 0, status.text);
    assert.match(status.out, /acme\/widgets: agentsys-loop-acme_widgets\.service active, every 900s\n {2}last pass pass_7 ended 2026-11-17T10:00:00.000Z — waiting: the review window resets at 14:00/);
    assert.match(status.out, /acme\/gadgets: agentsys-loop-acme_gadgets\.service active, every 900s\n {2}no pass recorded yet/);
  });

  it('says so when nothing is armed', () => {
    assert.match(cli(['loop', 'status']).out, /No loop is armed\. Arm one with `agentsys loop arm --repo <checkout>`\./);
  });

  it('disarms the repository named and leaves the others running', () => {
    const a = repo('widgets');
    cli(['loop', 'arm', '--repo', a]);
    cli(['loop', 'arm', '--repo', repo('gadgets')]);
    const before = calls().length;
    const done = cli(['loop', 'disarm', '--repo', 'acme/gadgets']);
    assert.equal(done.code, 0, done.text);
    assert.deepEqual(calls().slice(before), ['disable --now agentsys-loop-acme_gadgets.service']);
    assert.match(done.out, /Stopped and disabled agentsys-loop-acme_gadgets\.service for acme\/gadgets/);
    // A checkout path names the repository as well.
    assert.equal(cli(['loop', 'disarm', '--repo', a]).code, 0);
    assert.equal(calls().at(-1), 'disable --now agentsys-loop-acme_widgets.service');
  });

  it('refuses to guess which of several loops to disarm, and stops none', () => {
    cli(['loop', 'arm', '--repo', repo('widgets')]);
    cli(['loop', 'arm', '--repo', repo('gadgets')]);
    const before = calls().length;
    const done = cli(['loop', 'disarm']);
    assert.notEqual(done.code, 0);
    assert.doesNotMatch(done.text, /\n\s+at /, 'a message for the operator, not a stack trace');
    assert.match(done.text, /2 loops are armed \(acme\/gadgets, acme\/widgets\); name one with --repo/);
    assert.equal(calls().length, before);
  });

  it('disarms the only armed loop without being told which', () => {
    cli(['loop', 'arm', '--repo', repo('widgets')]);
    assert.equal(cli(['loop', 'disarm']).code, 0);
    assert.equal(calls().at(-1), 'disable --now agentsys-loop-acme_widgets.service');
  });

  it('names the repository that is not armed and the ones that are', () => {
    cli(['loop', 'arm', '--repo', repo('widgets')]);
    const done = cli(['loop', 'disarm', '--repo', 'acme/other']);
    assert.notEqual(done.code, 0);
    assert.match(done.text, /acme\/other is not armed\. Armed: acme\/widgets\./);
    assert.match(cli(['loop', 'disarm', '--repo', 'nothing-to-see']).text, /nothing-to-see is not armed/);
  });

  it('says what is in place when systemctl refuses to start the new loop, and leaves the first one running', () => {
    cli(['loop', 'arm', '--repo', repo('widgets')]);
    const before = calls().length;
    const done = cli(['loop', 'arm', '--repo', repo('gadgets')], { REFUSE: 'enable' });
    assert.notEqual(done.code, 0);
    assert.match(done.text, /Starting agentsys-loop-acme_gadgets\.service failed: Failed to connect to bus: No medium found/);
    assert.match(done.text, /acme\/gadgets is not running yet\. Fix the cause and run the same `agentsys loop arm` command again\./);
    assert.ok(calls().slice(before).every((c) => !c.includes('acme_widgets')), 'the first loop was not touched');
    // The same command, once the cause is gone, finishes the job.
    assert.equal(cli(['loop', 'arm', '--repo', join(dir, 'gadgets')]).code, 0);
    assert.equal(calls().at(-1), 'enable --now agentsys-loop-acme_gadgets.service');
  });

  it('refuses a directory that is not a GitHub checkout, before writing or starting anything', () => {
    const plain = join(dir, 'plain');
    execFileSync('git', ['init', '--quiet', plain]);
    const done = cli(['loop', 'arm', '--repo', plain]);
    assert.notEqual(done.code, 0);
    assert.equal(calls().length, 0);
    assert.equal(existsSync(join(dir, 'state', 'loop')), false);
  });

  describe('after an older build armed one repository', () => {
    /** What `agentsys loop arm` left before this change: one record and one fixed unit. */
    function legacyArmed(path: string): void {
      mkdirSync(join(dir, 'state', 'loop'), { recursive: true });
      writeFileSync(join(dir, 'state', 'loop', 'armed.json'), JSON.stringify({ repoPath: path, intervalSeconds: 600, policyRef: 'origin/main' }));
      mkdirSync(dirname(unitFile('x')), { recursive: true });
      writeFileSync(unitFile('agentsys-loop.service'), '[Service]\nExecStart=node main.js loop --armed\n');
    }

    it('keeps that loop: it is listed, and `loop --armed` still reads its record', () => {
      const a = repo('widgets');
      legacyArmed(a);
      const status = cli(['loop', 'status']);
      assert.match(status.out, /acme\/widgets: agentsys-loop\.service active, every 600s \(armed by an older build; arm it again/);
      // `loop --armed` with no slug is what the old unit runs: it finds the old record rather than refusing.
      const run = cli(['loop', '--armed', '--once', '--dry-run'], { GIT_TERMINAL_PROMPT: '0' });
      assert.doesNotMatch(run.text, /--armed needs/);
    });

    it('leaves it running when another repository is armed', () => {
      legacyArmed(repo('widgets'));
      assert.equal(cli(['loop', 'arm', '--repo', repo('gadgets')]).code, 0);
      assert.ok(calls().every((c) => !c.includes('agentsys-loop.service')));
      assert.ok(existsSync(join(dir, 'state', 'loop', 'armed.json')));
      assert.match(cli(['loop', 'status']).out, /acme\/widgets: agentsys-loop\.service[\s\S]*acme\/gadgets: agentsys-loop-acme_gadgets\.service/);
    });

    it('is replaced, not doubled, when its own repository is armed again', () => {
      const a = repo('widgets');
      legacyArmed(a);
      const done = cli(['loop', 'arm', '--repo', a, '--interval', '600']);
      assert.equal(done.code, 0, done.text);
      assert.match(done.out, /Replaced the old service agentsys-loop\.service, which ran acme\/widgets\./);
      assert.deepEqual(calls().filter((c) => c.startsWith('disable') || c.startsWith('enable')),
        ['disable --now agentsys-loop.service', 'enable --now agentsys-loop-acme_widgets.service']);
      assert.equal(existsSync(join(dir, 'state', 'loop', 'armed.json')), false);
      assert.equal(existsSync(unitFile('agentsys-loop.service')), false);
      assert.deepEqual(readdirSync(dirname(unitFile('x'))), ['agentsys-loop-acme_widgets.service']);
    });

    it('changes nothing, and says so, when systemctl will not stop it', () => {
      const a = repo('widgets');
      legacyArmed(a);
      const done = cli(['loop', 'arm', '--repo', a], { REFUSE: 'disable' });
      assert.notEqual(done.code, 0);
      assert.match(done.text, /Nothing was changed: agentsys-loop\.service is still running acme\/widgets\./);
      assert.ok(existsSync(join(dir, 'state', 'loop', 'armed.json')), 'the old record is still there');
      assert.equal(existsSync(record('acme_widgets')), false, 'no second record was written');
      assert.equal(existsSync(unitFile('agentsys-loop-acme_widgets.service')), false, 'and no second unit');
      assert.ok(!calls().some((c) => c.startsWith('enable')), 'no second loop was started on the same repository');
      assert.match(cli(['loop', 'status']).out, /^acme\/widgets: agentsys-loop\.service active[^\n]*\n[^\n]*\n$/, 'one loop is listed, the one still running');
    });

    it('says the old service is gone and the new one is not running when starting the new one is refused', () => {
      const a = repo('widgets');
      legacyArmed(a);
      const done = cli(['loop', 'arm', '--repo', a], { REFUSE: 'enable' });
      assert.notEqual(done.code, 0);
      assert.match(done.text, /acme\/widgets is not running yet, and agentsys-loop\.service no longer is\./);
      assert.equal(cli(['loop', 'arm', '--repo', a]).code, 0, 'the same command finishes the job');
      assert.equal(calls().at(-1), 'enable --now agentsys-loop-acme_widgets.service');
    });

    it('refuses, changing nothing, when its checkout is gone and so cannot be told apart from the repository being armed', () => {
      legacyArmed(join(dir, 'gone'));
      const done = cli(['loop', 'arm', '--repo', repo('widgets')]);
      assert.notEqual(done.code, 0);
      assert.match(done.text, /agentsys-loop\.service, armed by an older build, names .*gone, which is not a GitHub checkout now/);
      assert.match(done.text, /Nothing was changed\. Stop it with `systemctl --user disable --now agentsys-loop\.service`/);
      assert.equal(calls().length, 0);
      assert.equal(existsSync(record('acme_widgets')), false);
    });

    it('disarms by repository like any other', () => {
      legacyArmed(repo('widgets'));
      assert.equal(cli(['loop', 'disarm', '--repo', 'acme/widgets']).code, 0);
      assert.equal(calls().at(-1), 'disable --now agentsys-loop.service');
    });
  });
});
