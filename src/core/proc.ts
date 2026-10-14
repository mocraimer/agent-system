/**
 * Process-liveness helpers shared by the parts of the coordinator that start
 * long-running local processes and later have to ask about them.
 */

/** True while a process with this id exists, including one this user may not signal. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Stop a process started with `detached: true` and everything it started.
 *
 * Killing only the leader leaves its children — a test runner's browsers, a
 * model CLI's tool calls — running with nobody to reap them.
 */
export function killGroup(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}
