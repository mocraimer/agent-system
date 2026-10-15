import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The target repository's git, as the loop needs it.
 *
 * The loop never reads the working tree it is pointed at: other sessions switch
 * branches in that directory, so a file read there is whatever branch happened to
 * be checked out. Everything is read from the fetched base branch instead, and
 * work happens in worktrees the loop creates and removes itself. See
 * docs/adr/20261015-loop-policy-read-from-target-base.md.
 */
export interface Repo {
  readonly path: string;
  /** `owner/name` from the origin remote. */
  slug(): Promise<string>;
  fetch(refs: string[]): Promise<void>;
  /** A file's content at a ref, e.g. `origin/dev`. */
  show(ref: string, file: string): Promise<string>;
  /** Whether a file exists at a ref. */
  has(ref: string, file: string): Promise<boolean>;
  /** Resolve a ref in the target checkout or in the isolated worker worktree. */
  revParse(ref: string, dir?: string): Promise<string>;
  /** Commits reachable from `to` and not from `from`, newest first, with full messages. */
  log(from: string, to: string): Promise<Array<{ sha: string; message: string }>>;
  /** Create a worktree at `dir`. With `branch`, check out that branch; otherwise detach at `ref`. */
  addWorktree(dir: string, ref: string, branch?: string): Promise<void>;
  removeWorktree(dir: string): Promise<void>;
}

export class GitRepo implements Repo {
  constructor(readonly path: string) {}

  private async git(args: string[]): Promise<string> {
    const { stdout } = await run('git', ['-C', this.path, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  async slug(): Promise<string> {
    // The configured URL, before any `insteadOf` rewrite: a fixture clone points a
    // GitHub-shaped name at a local repository.
    const url = (await this.git(['config', '--get', 'remote.origin.url'])).trim();
    const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    if (!m) throw new Error(`The origin remote of ${this.path} is not a GitHub repository: ${url}`);
    return m[1]!;
  }

  async fetch(refs: string[]): Promise<void> {
    await this.git(['fetch', '--quiet', 'origin', ...refs]);
  }

  show(ref: string, file: string): Promise<string> {
    return this.git(['show', `${ref}:${file}`]);
  }

  has(ref: string, file: string): Promise<boolean> {
    return this.git(['cat-file', '-e', `${ref}:${file}`]).then(() => true, () => false);
  }

  async revParse(ref: string, dir = this.path): Promise<string> {
    const { stdout } = await run('git', ['-C', dir, 'rev-parse', ref]);
    return stdout.trim();
  }

  async log(from: string, to: string): Promise<Array<{ sha: string; message: string }>> {
    const out = await this.git(['log', '--format=%H%x00%B%x1e', `${from}..${to}`]);
    return out.split('\x1e').map((e) => e.trim()).filter(Boolean).map((e) => {
      const [sha, ...rest] = e.split('\x00');
      return { sha: sha!.trim(), message: rest.join('\x00') };
    });
  }

  async addWorktree(dir: string, ref: string, branch?: string): Promise<void> {
    // A worktree left by a pass that died is removed first; its contents were never pushed work.
    await this.removeWorktree(dir);
    mkdirSync(dirname(dir), { recursive: true });
    if (branch) await this.git(['worktree', 'add', '--force', '-B', branch, dir, ref]);
    else await this.git(['worktree', 'add', '--force', '--detach', dir, ref]);
  }

  async remoteBranchExists(branch: string): Promise<boolean> {
    const out = await this.git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
    return out.trim() !== '';
  }

  /** Commit one file in a worktree; returns the new head. */
  async commitFile(dir: string, file: string, message: string): Promise<string> {
    await run('git', ['-C', dir, 'add', '--', file]);
    await run('git', ['-C', dir, 'commit', '--quiet', '-m', message]);
    return (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();
  }

  /** Push a worktree's head to a branch. Never forced: a push that is not a fast-forward fails. */
  async push(dir: string, branch: string): Promise<void> {
    await run('git', ['-C', dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
  }

  async deleteRemoteBranch(branch: string): Promise<void> {
    await this.git(['push', '--quiet', 'origin', '--delete', branch]);
  }

  async removeWorktree(dir: string): Promise<void> {
    if (existsSync(dir)) {
      try {
        await this.git(['worktree', 'remove', '--force', dir]);
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    await this.git(['worktree', 'prune']);
  }
}
