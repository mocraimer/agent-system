import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor } from './authority.js';
import { writeJson } from './store.js';

/** The operator this test installation answers to. */
export const OPERATOR: Actor = { kind: 'operator', id: 'operator@example.test' };

/** An agent's own claim of authority. Used to prove such claims are inert. */
export const AGENT_ACTOR: Actor = { kind: 'agent', id: 'run_abc123' };

/** Automation speaking for a CI event. */
export const AUTOMATION_ACTOR: Actor = { kind: 'automation', id: 'github-actions' };

export interface Sandbox {
  root: string;
  cleanup(): void;
}

/**
 * Point the store at a throwaway directory for one test.
 *
 * Tests must not share state: authority and reservations are both read from disk
 * by directory listing, so a leaked record from an earlier test would silently
 * satisfy a later one's precondition.
 */
export function sandbox(operator: string | null = OPERATOR.id): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'agentsys-test-'));
  process.env['AGENTSYS_STATE'] = root;
  // `null`, not `undefined`: passing `undefined` would select the default parameter
  // and quietly configure an operator in a test that means to have none.
  if (operator !== null) writeJson(join(root, 'config.json'), { operator });
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      delete process.env['AGENTSYS_STATE'];
    },
  };
}
