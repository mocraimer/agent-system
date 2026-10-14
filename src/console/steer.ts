import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../loop/github.js';
import { parseStoreConfig, STORE_CONFIG_PATH } from '../loop/policy.js';
import type { LoopPolicy } from '../loop/policy.js';

/**
 * Changing policy from the console is proposing it.
 *
 * The loop reads its policy only from the store configuration on the base
 * branch. A change the operator makes in Steer — or one the improve stage drafts
 * — is therefore a commit on its own branch and a pull request against that
 * base; the live policy moves only when a person merges it. Nothing here writes
 * to the base branch, and nothing pushes with force.
 */

/** The git a proposal needs: worktrees, one commit, a plain push. */
export interface ProposalGit {
  fetch(refs: string[]): Promise<void>;
  show(ref: string, file: string): Promise<string>;
  remoteBranchExists(branch: string): Promise<boolean>;
  addWorktree(dir: string, ref: string, branch?: string): Promise<void>;
  removeWorktree(dir: string): Promise<void>;
  commitFile(dir: string, file: string, message: string): Promise<string>;
  push(dir: string, branch: string): Promise<void>;
  deleteRemoteBranch(branch: string): Promise<void>;
}

export interface FileProposal {
  base: string;
  /** One branch per thing being changed, so a second change to it updates the same pull request. */
  branch: string;
  file: string;
  /** The new file text from the text on the branch the proposal starts from; unchanged text is refused. */
  edit(text: string): string;
  /** Checks the edited text before anything is committed; throws to refuse. */
  validate?(text: string): void;
  commitMessage: string;
  title: string;
  body: string;
}

export interface ProposalResult {
  branch: string;
  pr: number;
  commit: string;
  /** False when an open pull request from the branch was updated rather than opened. */
  opened: boolean;
}

export class ProposalRefused extends Error {
  override readonly name = 'ProposalRefused';
}

/**
 * Commit one file change on `branch` and open — or update — its pull request.
 *
 * A branch with an open pull request gets a further commit on top, so its pull
 * request is the one that changes. A branch left behind by a closed or merged
 * one is deleted first and started again from the base: extending it would need
 * a forced push. If opening the pull request fails, a branch this call created is
 * deleted again, so a failure leaves nothing half-made behind.
 */
export async function proposeFileChange(
  deps: { git: ProposalGit; store: Pick<Store, 'openPulls' | 'createPull' | 'updatePullBody'>; worktree: string },
  p: FileProposal,
): Promise<ProposalResult> {
  const { git, store } = deps;
  await git.fetch([p.base]);
  const open = (await store.openPulls(p.base, p.branch))[0];
  const exists = await git.remoteBranchExists(p.branch);
  if (exists && open) await git.fetch([`+refs/heads/${p.branch}:refs/remotes/origin/${p.branch}`]);
  if (exists && !open) await git.deleteRemoteBranch(p.branch);
  await git.addWorktree(deps.worktree, open ? `origin/${p.branch}` : `origin/${p.base}`, p.branch);
  let pushedNew = false;
  try {
    const path = join(deps.worktree, p.file);
    const before = readFileSync(path, 'utf8');
    const after = p.edit(before);
    if (after === before) {
      // The open pull request already proposes exactly this; only its account of why is renewed.
      if (open) {
        await store.updatePullBody(open.number, p.body);
        return { branch: p.branch, pr: open.number, commit: '', opened: false };
      }
      throw new ProposalRefused(`${p.file} on ${p.base} already says that; there is nothing to propose.`);
    }
    p.validate?.(after);
    writeFileSync(path, after, 'utf8');
    const commit = await git.commitFile(deps.worktree, p.file, p.commitMessage);
    await git.push(deps.worktree, p.branch);
    pushedNew = !open;
    if (open) {
      await store.updatePullBody(open.number, p.body);
      return { branch: p.branch, pr: open.number, commit, opened: false };
    }
    const pr = await store.createPull({ base: p.base, head: p.branch, title: p.title, body: p.body });
    return { branch: p.branch, pr, commit, opened: true };
  } catch (err) {
    if (pushedNew) await git.deleteRemoteBranch(p.branch).catch(() => undefined);
    throw err;
  } finally {
    // A cleanup failure must not replace the error that ended the proposal.
    await git.removeWorktree(deps.worktree).catch(() => undefined);
  }
}

/* ----------------------------------------------------------- table edits */

/**
 * Replace, or add, one row of the first table under a `###` heading. Only that
 * row's line changes; every other byte of the file is kept. A row that is added
 * goes before the first row `addBefore` names, else after the last row `addAfter`
 * names, else at the end.
 */
export function editTableRow(
  text: string, heading: string, key: (cells: string[]) => boolean, row: string,
  addBefore?: (cells: string[]) => boolean, addAfter?: (cells: string[]) => boolean,
): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  const start = lines.findIndex((l) => l.trim() === `### ${heading}`);
  if (start === -1) throw new ProposalRefused(`${STORE_CONFIG_PATH} has no "### ${heading}" heading.`);
  const rows: number[] = [];
  let seen = false;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (/^#{1,3} /.test(t)) break;
    if (!t.startsWith('|')) { if (seen) break; continue; }
    seen = true;
    rows.push(i);
  }
  if (rows.length < 2) throw new ProposalRefused(`${STORE_CONFIG_PATH} has no table under "### ${heading}".`);
  const cells = (i: number): string[] => lines[i]!.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim().replace(/`/g, ''));
  const body = rows.slice(2); // header and separator
  const match = body.find((i) => key(cells(i)));
  if (match !== undefined) {
    lines[match] = row;
  } else {
    const before = addBefore ? body.find((i) => addBefore(cells(i))) : undefined;
    const after = addAfter ? body.filter((i) => addAfter(cells(i))).pop() : undefined;
    const at = before ?? (after !== undefined ? after + 1 : body.length > 0 ? body[body.length - 1]! + 1 : rows[1]! + 1);
    lines.splice(at, 0, row);
  }
  return lines.join(eol);
}

/* ----------------------------------------------------------- the changes Steer makes */

export type PolicyChange =
  | { kind: 'stop-line'; label: string; value: number }
  | { kind: 'tier'; stage: string; runtime: string; model: string; effort: string; fiveHourPercent: number; weeklyPercent: number }
  | { kind: 'limit'; setting: string; value: string };

const slugOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function branchFor(change: PolicyChange): string {
  switch (change.kind) {
    case 'stop-line': return `console/stop-line-${change.label === 'default' ? 'default' : slugOf(change.label)}`;
    case 'tier': return `console/tier-${slugOf(change.stage)}-${slugOf(change.runtime)}`;
    case 'limit': return `console/limit-${slugOf(change.setting)}`;
  }
}

/** What a change names, as a reader of the table sees it. */
export function describeChange(change: PolicyChange): string {
  switch (change.kind) {
    case 'stop-line': return `${change.label === 'default' ? 'default' : change.label} stop-line`;
    case 'tier': return `${change.stage} stage tier on ${change.runtime}`;
    case 'limit': return `"${change.setting}" loop limit`;
  }
}

/** The live value of what a change names, in the table's own words, or `none` when the row is absent. */
export function currentValue(policy: LoopPolicy, change: PolicyChange): string {
  switch (change.kind) {
    case 'stop-line': {
      const row = change.label === 'default' ? policy.defaultStopLine : policy.typeStopLines.get(change.label);
      return row ? String(row.value) : `none (the default, ${policy.defaultStopLine.value}, applies)`;
    }
    case 'tier': {
      const t = policy.stageTiers.get(change.stage)?.find((o) => o.runtime === change.runtime);
      return t ? `${t.runtime} · ${t.model} · ${t.effort} · ${t.fiveHourPercent}% · ${t.weeklyPercent}%` : 'none';
    }
    case 'limit': return policy.limits.get(change.setting)?.value ?? 'none';
  }
}

export function proposedValue(change: PolicyChange): string {
  switch (change.kind) {
    case 'stop-line': return String(change.value);
    case 'tier': return `${change.runtime} · ${change.model} · ${change.effort} · ${change.fiveHourPercent}% · ${change.weeklyPercent}%`;
    case 'limit': return change.value;
  }
}

/** Apply a change to the store configuration's text, touching only its row. */
export function applyChange(text: string, change: PolicyChange): string {
  switch (change.kind) {
    case 'stop-line': {
      if (change.label === 'default') return replaceDefault(text, change.value);
      return editTableRow(text, 'Stop-line by type', (c) => c[0] === change.label, `| \`${change.label}\` | ${change.value} |`, (c) => (c[0] ?? '').startsWith('default'));
    }
    case 'tier':
      // One row per stage and runtime: a change edits the row naming both, or adds
      // the runtime's row after the stage's last one.
      return editTableRow(text, 'Stage tiers', (c) => c[0] === change.stage && c[1] === change.runtime,
        `| ${change.stage} | ${change.runtime} | ${change.model} | ${change.effort} | ${change.fiveHourPercent} | ${change.weeklyPercent} |`,
        undefined, (c) => c[0] === change.stage);
    case 'limit':
      return editTableRow(text, 'Loop limits', (c) => c[0] === change.setting, `| ${change.setting} | ${change.value} |`);
  }
}

/** The default row keeps its own wording; only its number changes. */
function replaceDefault(text: string, value: number): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  const start = lines.findIndex((l) => l.trim() === '### Stop-line by type');
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (/^#{1,3} /.test(t)) break;
    if (/^\|\s*default/.test(t)) {
      lines[i] = lines[i]!.replace(/\|\s*\d+\s*\|\s*$/, `| ${value} |`);
      return lines.join(eol);
    }
  }
  throw new ProposalRefused(`${STORE_CONFIG_PATH} "Stop-line by type" has no default row.`);
}

/** The pull request body a policy proposal carries: what changes, from what, to what, and who asked. */
export function renderProposalBody(change: PolicyChange, live: string, by: string, source: string): string {
  return [
    `Proposes a change to the ${describeChange(change)} in \`${STORE_CONFIG_PATH}\`.`,
    '',
    '| | Value |',
    '|---|---|',
    `| Live (${source}) | ${live} |`,
    `| Proposed | ${proposedValue(change)} |`,
    '',
    `Changed by **${by}** from the agentsys console. The loop reads its policy only from the base branch, so nothing changes until a person merges this pull request.`,
  ].join('\n');
}

export interface PolicyProposalDeps {
  git: ProposalGit;
  store: Pick<Store, 'openPulls' | 'createPull' | 'updatePullBody'>;
  base: string;
  worktree: string;
}

/** Propose one policy change as a pull request against the base branch. */
export async function proposePolicy(deps: PolicyProposalDeps, change: PolicyChange, by: string): Promise<ProposalResult & { live: string; proposed: string }> {
  await deps.git.fetch([deps.base]);
  const liveText = await deps.git.show(`origin/${deps.base}`, STORE_CONFIG_PATH);
  const live = currentValue(parseStoreConfig(liveText), change);
  const result = await proposeFileChange({ git: deps.git, store: deps.store, worktree: deps.worktree }, {
    base: deps.base,
    branch: branchFor(change),
    file: STORE_CONFIG_PATH,
    edit: (text) => applyChange(text, change),
    validate: (text) => { parseStoreConfig(text); },
    commitMessage: `chore(policy): propose the ${describeChange(change)} ${live} → ${proposedValue(change)}\n\nProposed by ${by} from the agentsys console.`,
    title: `chore(policy): ${describeChange(change)} ${live} → ${proposedValue(change)}`,
    body: renderProposalBody(change, live, by, `origin/${deps.base}`),
  });
  return { ...result, live, proposed: proposedValue(change) };
}
