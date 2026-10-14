import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { PiAdapter } from './pi.js';

it('dispatches both current policy Pi review tiers with exact subprocess settings and observed readback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-model-selection-'));
  try {
    const bin = join(root, 'fake-pi');
    const argv = join(root, 'argv.json');
    writeFileSync(bin, [
      '#!/usr/bin/env node',
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)));`,
      "if (process.argv.includes('--version')) process.exit(0);",
      "const { createInterface } = require('node:readline');",
      "const args = process.argv.slice(2);",
      "const model = args[args.indexOf('--model') + 1];",
      "const effort = args[args.indexOf('--thinking') + 1];",
      "const reply = (body) => process.stdout.write(JSON.stringify(body) + '\\n');",
      "createInterface({ input: process.stdin }).on('line', (line) => {",
      "  const request = JSON.parse(line);",
      "  if (request.type === 'get_commands') reply({ type: 'response', id: request.id, command: request.type, success: true, data: { commands: [] } });",
      "  if (request.type === 'prompt') { reply({ type: 'response', id: request.id, command: request.type, success: true }); reply({ type: 'agent_settled' }); }",
      "  if (request.type === 'get_state') reply({ type: 'response', id: request.id, command: request.type, success: true, data: { model: { id: model }, thinkingLevel: effort } });",
      '});',
    ].join('\n'));
    chmodSync(bin, 0o755);
    const adapter = new PiAdapter(bin, root);
    for (const [model, effort] of [['gpt-6-sol', 'high'], ['gpt-6-luna', 'max']] as const) {
      const result = await adapter.dispatch({
        taskId: `review-${model}`, runId: `run-${model}`, task: 'Controlled review',
        repoPath: root, evidenceDir: join(root, `evidence-${model}`), entry: 'prompt',
        settings: {}, approvedTier: { model, effort }, timeoutMs: 2_000,
      });
      assert.equal(result.outcome.kind, 'completed');
      assert.deepEqual(result.settings.resolved, { model, effort });
      assert.deepEqual(result.settings.observed, { model, effort });
      assert.deepEqual(JSON.parse(readFileSync(argv, 'utf8')), ['--mode', 'rpc', '--model', model, '--thinking', effort]);
      assert.doesNotMatch(result.skill?.invocation ?? '', /gpt-5\.6-(sol|luna)/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
