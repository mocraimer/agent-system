import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { short, ticketOf, worktreeDir } from '../context.js';
import type { PullRequest } from '../github.js';
import { renderVerificationMarker, verificationHeads } from '../markers.js';
import { limit, resolveStopLine, rung } from '../policy.js';
import type { ReleaseCheck } from '../policy.js';
import type { ActResult, Fault, Item, PassContext, StagePlan } from '../types.js';

export type CheckVerdict = 'pass' | 'fail' | 'blocked';

export interface CheckResult {
  name: string;
  verdict: CheckVerdict;
  command: string;
  directory: string;
  commit: string;
  /** Why it could not run, for `blocked`. */
  reason?: string;
  /** The deciding lines, verbatim. */
  output: string;
}

/** The last lines of a command's output, which is where each of these scripts states its verdict. */
function deciding(stdout: string, stderr: string, lines = 25): string {
  const all = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim().split('\n');
  return all.slice(-lines).join('\n');
}

/**
 * Rung 7: once a person has merged the release and the deploy workflow has
 * completed for the release branch's head, run the store's release checks and
 * post what they found on the release pull request — pass, fail or blocked for
 * each, with the command, where it ran, and its deciding output verbatim. A check
 * that could not run says blocked; nothing is reported as a pass by default. A
 * failing check becomes an issue.
 *
 * The deploy workflow and the checks are the store configuration's "Coordinator
 * protocol" and "Release checks"; a store that names neither has nothing to verify.
 *
 * It runs only where a ticket in the release has a stop-line at this rung, or
 * where the operator names the release with `--release`.
 */
export async function planVerify(ctx: PassContext): Promise<StagePlan> {
  const stageRung = rung(ctx.policy, 'verified');
  const plan: StagePlan = { stage: 'verify', rung: stageRung, items: [], notes: [], faults: [] };
  const { releaseBranch: { value: releaseBranch }, deployWorkflow, releaseChecks } = ctx.policy.protocol;
  if (!deployWorkflow || releaseChecks.length === 0) {
    plan.items.push({ ref: 'release', decision: { kind: 'skip', reason: `the store configuration names ${deployWorkflow ? 'no release checks' : 'no deploy workflow'}, so there is nothing to verify` } });
    return plan;
  }
  const workflow = deployWorkflow.value;

  const releases = (await ctx.store.mergedPulls(releaseBranch, ctx.base)).filter((p) => p.mergedAt)
    .sort((a, b) => Date.parse(b.mergedAt!) - Date.parse(a.mergedAt!));
  const named = ctx.options.releasePr;
  const release = named !== undefined ? releases.find((p) => p.number === named) : releases[0];
  if (!release) {
    plan.items.push({ ref: named !== undefined ? `PR #${named}` : 'release', decision: { kind: 'skip', reason: named !== undefined ? `PR #${named} is not a merged ${ctx.base} → ${releaseBranch} pull request` : 'no merged release pull request' } });
    return plan;
  }
  const ref = `PR #${release.number}`;

  // Whether this release is owed a verification at all comes first: a release whose
  // tickets all stop below this rung has nothing to verify, whatever evidence or
  // deploy state it carries.
  if (named === undefined) {
    const reaching = await ticketsReaching(ctx, release, releases, stageRung.number);
    if (reaching.length === 0) {
      plan.items.push({ ref, decision: { kind: 'skip', reason: `no ticket in this release has stop-line ≥ ${stageRung.number}` } });
      return plan;
    }
  }

  const mainHead = await ctx.store.branchHead(releaseBranch);
  // The deploy of this exact commit, not the newest run of the workflow: a
  // newest-run read answered with an August deploy once, and a verification
  // credited to the wrong deploy is worse than none.
  const deploy = (await ctx.store.runsForCommit(releaseBranch, mainHead))
    .filter((r) => r.workflow === workflow && r.headSha === mainHead)
    .sort((a, b) => Date.parse(b.attemptStartedAt ?? '') - Date.parse(a.attemptStartedAt ?? '') || b.id - a.id || (b.runAttempt ?? 1) - (a.runAttempt ?? 1))[0];
  plan.notes.push(`verify: ${releaseBranch} at ${mainHead}; ${workflow} ${deploy ? `run ${deploy.id} attempt ${deploy.runAttempt ?? 1} ${deploy.status}/${deploy.conclusion ?? '-'}` : 'has no run for that commit'}`);
  if (!deploy || deploy.status !== 'completed') {
    plan.items.push({ ref, decision: { kind: 'skip', reason: `${workflow} ${deploy ? `run ${deploy.id} is ${deploy.status}` : 'has no run'} for ${releaseBranch} ${short(mainHead)}; wait for a successful deployment` } });
    return plan;
  }
  if (deploy.conclusion !== 'success') {
    plan.items.push({ ref, decision: { kind: 'blocked', reason: `${workflow} run ${deploy.id} attempt ${deploy.runAttempt ?? 1} concluded ${deploy.conclusion ?? 'unknown'} for ${releaseBranch} ${short(mainHead)}; inspect the failed deployment before retrying` } });
    return plan;
  }
  const comments = await ctx.comments(release.number);
  const sameAttempt = comments.filter((c) => verificationHeads(c.body).some((h) => h.toLowerCase() === mainHead.toLowerCase())
    && c.body.includes(`Deployment run: ${deploy.id}, attempt ${deploy.runAttempt ?? 1}`)).at(-1);
  if (sameAttempt) {
    const passed = allChecksPassed(sameAttempt.body, releaseChecks.map((c) => c.name));
    plan.items.push({ ref, decision: passed
      ? { kind: 'skip', reason: `all ${releaseChecks.length} post-deploy checks passed for ${releaseBranch} ${short(mainHead)}, run ${deploy.id} attempt ${deploy.runAttempt ?? 1} already` }
      : { kind: 'blocked', reason: `post-deploy checks for ${releaseBranch} ${short(mainHead)}, run ${deploy.id} attempt ${deploy.runAttempt ?? 1} did not all pass; inspect the verification comment and resolve the failures` } });
    return plan;
  }
  // Old result comments identify the main commit, not the deployment attempt. They
  // are real evidence, but cannot certify a rerun at that same commit. Do not
  // silently repeat checks (and possibly create duplicate failure issues).
  const legacy = comments.find((c) => verificationHeads(c.body).some((h) => mainHead.toLowerCase().startsWith(h.toLowerCase()))
    && !/Deployment run: \d+, attempt \d+/.test(c.body));
  if (legacy) {
    plan.items.push({ ref, decision: { kind: 'blocked', reason: `prior verification exists for ${releaseBranch} ${short(mainHead)} with unknown deployment attempt; reconcile it before running checks again` } });
    return plan;
  }

  const item: Item = {
    ref,
    decision: { kind: 'dispatch', detail: `run the ${releaseChecks.length} post-deploy checks against ${releaseBranch} ${short(mainHead)}${named !== undefined ? ' (named by the operator)' : ''}` },
    act: () => verifyRelease(ctx, release, mainHead, deploy.id, deploy.runAttempt ?? 1),
  };
  plan.items.push(item);
  return plan;
}

/** Read the rendered check sections, never lines printed by a check. Malformed evidence is not a pass. */
function allChecksPassed(body: string, names: string[]): boolean {
  const lines = body.split('\n');
  let at = lines.findIndex((line) => line.startsWith('### '));
  if (at < 0) return false;
  for (const [index, name] of names.entries()) {
    if (lines[at++] !== `### ${name}: pass` || lines[at++] !== '') return false;
    if (!lines[at++]?.startsWith('- Command: `') || !lines[at++]?.startsWith('- Directory: `')) return false;
    if (lines[at]?.startsWith('- Why it could not run: ')) at++;
    if (lines[at++] !== '' || lines[at++] !== '```') return false;
    while (at < lines.length && lines[at] !== '```') at++;
    if (at === lines.length) return false;
    at++;
    if (lines[at] === '') at++;
    else if (index !== names.length - 1) return false;
  }
  return lines.slice(at).every((line) => line === '');
}

async function ticketsReaching(ctx: PassContext, release: PullRequest, releases: PullRequest[], atLeast: number): Promise<number[]> {
  const previous = releases.find((p) => Date.parse(p.mergedAt!) < Date.parse(release.mergedAt!));
  const from = previous ? Date.parse(previous.mergedAt!) : 0;
  const to = Date.parse(release.mergedAt!);
  const out: number[] = [];
  for (const pr of await ctx.store.mergedPulls(ctx.base)) {
    const ticket = ticketOf(pr);
    if (ticket === undefined || !pr.mergedAt) continue;
    const at = Date.parse(pr.mergedAt);
    if (at <= from || at > to) continue;
    const issue = await ctx.issue(ticket);
    if (resolveStopLine(ctx.policy, issue?.labels ?? []).rung >= atLeast) out.push(ticket);
  }
  return out;
}

/**
 * Checks that run in `base` are tooling and the deployed commit is their subject,
 * so they run from the base branch — where the newest version of each lives —
 * against the release branch commit that was deployed. A release cut before a
 * check existed would otherwise have nothing to run it with. Checks that run in
 * `deployed` need the operator's worktree of that commit, with its env files.
 */
async function verifyRelease(ctx: PassContext, release: PullRequest, mainHead: string, deployRunId: number, attempt: number): Promise<ActResult> {
  const dir = worktreeDir(ctx, 'verify-tools');
  await ctx.repo.addWorktree(dir, ctx.baseSha);
  const scratch = join(ctx.stateDir, 'verify', mainHead);
  mkdirSync(scratch, { recursive: true });
  const tools = { dir, commit: ctx.baseSha, ref: ctx.base };
  const results: CheckResult[] = [];
  try {
    const fill = await placeholders(ctx, tools, scratch, mainHead, deployRunId);
    for (const check of ctx.policy.protocol.releaseChecks) results.push(await runCheck(ctx, check, tools, mainHead, fill));
  } finally {
    await ctx.repo.removeWorktree(dir);
  }
  return postVerification(ctx, release, mainHead, results, { runId: deployRunId, attempt });
}

interface Tools { dir: string; commit: string; ref: string }

/** What a check's `{name}` placeholders become; `scope` is undefined when the deploy scope command could not say. */
interface Fill { values: Map<string, string>; scopeFailure?: { command: string; output: string } }

/**
 * `{commit}`, `{scratch}`, `{deploy-jobs}` (the deploy run's jobs as JSON) and
 * `{deploy-workflow}`, plus `{scope.<key>}` for each `key=value` line the deploy
 * scope command writes to `$GITHUB_OUTPUT`.
 */
async function placeholders(ctx: PassContext, tools: Tools, scratch: string, mainHead: string, deployRunId: number): Promise<Fill> {
  const { deployWorkflow, deployScope } = ctx.policy.protocol;
  const jobsPath = join(scratch, 'jobs.json');
  writeFileSync(jobsPath, JSON.stringify(await ctx.store.runJobs(deployRunId)), 'utf8');
  const values = new Map([['commit', mainHead], ['scratch', scratch], ['deploy-jobs', jobsPath], ['deploy-workflow', deployWorkflow?.value ?? '']]);
  if (!deployScope) return { values };
  const outputs = join(scratch, 'scope.env');
  writeFileSync(outputs, '', 'utf8');
  const argv = deployScope.value.map((a) => fillArg(a, values));
  const command = render(argv);
  const absent = missingScript(tools.dir, deployScope.value, tools);
  if (absent) return { values, scopeFailure: { command, output: absent } };
  const scope = await ctx.commands.exec(argv[0]!, argv.slice(1), { cwd: tools.dir, timeoutMs: 60_000, env: { GITHUB_OUTPUT: outputs } });
  if (scope.code !== 0) return { values, scopeFailure: { command, output: deciding(scope.stdout, scope.stderr) } };
  for (const line of readFileSync(outputs, 'utf8').split('\n').filter((l) => l.includes('='))) {
    values.set(`scope.${line.slice(0, line.indexOf('='))}`, line.slice(line.indexOf('=') + 1));
  }
  return { values };
}

async function runCheck(ctx: PassContext, check: ReleaseCheck, tools: Tools, mainHead: string, fill: Fill): Promise<CheckResult> {
  const { name } = check;
  const usesScope = check.argv.some((a) => a.includes('{scope.'));
  // An unknown scope value is filled in as empty, so the command can still be shown.
  const argv = check.argv.map((a) => fillArg(a, fill.values));
  const command = render(argv);
  const blocked = (directory: string, commit: string, reason: string, output = ''): CheckResult =>
    ({ name, verdict: 'blocked', command, directory, commit, reason, output });

  let directory: string;
  let commit: string;
  if (check.runIn.tree === 'base') {
    directory = join(tools.dir, check.runIn.subdirectory);
    commit = tools.commit;
    const absent = missingScript(directory, check.argv, tools);
    if (absent) return blocked(directory, commit, absent);
    if (usesScope && fill.scopeFailure) return blocked(directory, commit, `the deploy scope command could not say what was deployed: ${fill.scopeFailure.command}`, fill.scopeFailure.output);
  } else {
    const worktree = ctx.options.e2eWorktree;
    if (!worktree) return blocked('(none)', mainHead, 'no --e2e-worktree was given: this check needs an operator-prepared worktree of the deployed commit holding its env files');
    directory = join(worktree, check.runIn.subdirectory);
    const missingEnv = check.envFiles.filter((f) => !existsSync(join(worktree, f)));
    if (missingEnv.length > 0) return blocked(directory, mainHead, `the operator has not placed ${missingEnv.join(' and ')} in ${worktree}`);
    const at = await ctx.commands.exec('git', ['-C', worktree, 'rev-parse', 'HEAD'], { cwd: worktree, timeoutMs: 30_000 });
    commit = at.stdout.trim();
    if (commit !== mainHead) return blocked(directory, commit, `the worktree is at ${commit}, not the deployed ${ctx.policy.protocol.releaseBranch.value} head ${mainHead}`);
  }
  const run = await ctx.commands.exec(argv[0]!, argv.slice(1), { cwd: directory, timeoutMs: check.timeoutMs });
  const verdict: CheckVerdict = run.code === 0 ? 'pass' : run.code === 1 ? 'fail' : check.otherExits;
  return {
    name, verdict, command, directory, commit,
    ...(verdict === 'blocked' ? { reason: `exit ${run.code}` } : {}),
    output: deciding(run.stdout, run.stderr, 40),
  };
}

const fillArg = (arg: string, values: Map<string, string>): string => arg.replace(/\{([\w.-]+)\}/g, (_, key: string) => values.get(key) ?? '');

const render = (argv: string[]): string => argv.map((a) => (/\s/.test(a) || a === '' ? JSON.stringify(a) : a)).join(' ');

/**
 * A script the tree does not carry cannot run, which is blocked, not failed: every
 * relative path argument naming a script must exist where the command runs.
 */
function missingScript(directory: string, argv: string[], tools: Tools): string | undefined {
  const script = argv.find((a) => !a.startsWith('-') && !a.includes('{') && /\.(m?js|cjs|sh|py)$/.test(a) && !isAbsolute(a) && !existsSync(join(directory, a)));
  return script ? `${script} is not in ${tools.ref} at ${tools.commit}` : undefined;
}

/** Post the evidence comment and one issue per failing check. Exported for the unit test. */
export async function postVerification(ctx: PassContext, release: PullRequest, mainHead: string, results: CheckResult[], deploy?: { runId: number; attempt: number }): Promise<ActResult> {
  const body = [
    renderVerificationMarker(mainHead),
    `## Post-deploy verification of ${ctx.policy.protocol.releaseBranch.value} ${mainHead}`,
    ...(deploy ? [`Deployment run: ${deploy.runId}, attempt ${deploy.attempt}`] : []),
    '',
    `Run by the coordinator's loop in pass ${ctx.passId} after ${ctx.policy.protocol.deployWorkflow?.value ?? 'the deploy'} completed for this commit. Each check's`,
    'directory and commit below are where its script ran from; the commit it checked is the one in this heading.',
    '',
    ...results.flatMap((r) => [
      `### ${r.name}: ${r.verdict}`,
      '',
      `- Command: \`${r.command}\``,
      `- Directory: \`${r.directory}\` at ${r.commit}`,
      ...(r.reason ? [`- Why it could not run: ${r.reason}`] : []),
      '',
      '```',
      r.output.trim() === '' ? '(the command printed nothing)' : r.output.trim(),
      '```',
      '',
    ]),
  ].join('\n');
  const commentId = await ctx.store.createComment(release.number, body);

  const faults: Fault[] = [];
  const opened: number[] = [];
  const effort = limit(ctx.policy, 'status home').value;
  for (const failed of results.filter((r) => r.verdict === 'fail')) {
    const number = await ctx.store.createIssue({
      title: `${failed.name} failed after release PR #${release.number}`,
      labels: ['type:bug', effort],
      body: [
        `After release PR #${release.number} merged and ${ctx.policy.protocol.deployWorkflow?.value ?? 'the deploy'} completed, the post-deploy check **${failed.name}** failed.`,
        '',
        `- Commit: ${mainHead}`,
        `- Command: \`${failed.command}\``,
        `- Directory: \`${failed.directory}\``,
        `- Evidence comment: https://github.com/${ctx.slug}/pull/${release.number}#issuecomment-${commentId}`,
        '',
        'Deciding output, verbatim:',
        '',
        '```',
        failed.output.trim(),
        '```',
      ].join('\n'),
    });
    opened.push(number);
  }
  const counts = (['pass', 'fail', 'blocked'] as const).map((v) => `${v}=${results.filter((r) => r.verdict === v).length}`).join(' ');
  return {
    produced: true,
    summary: `post-deploy check results comment ${commentId} on PR #${release.number}: ${counts}${opened.length ? `; issue(s) ${opened.map((n) => `#${n}`).join(', ')} opened` : ''}`,
    ...(results.some((r) => r.verdict !== 'pass') ? { blocked: 'post-deploy checks did not all pass; inspect the result comment and resolve failed or unavailable checks' } : {}),
    faults,
  };
}

