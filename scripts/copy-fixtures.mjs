/** Copy non-TS files into dist: test fixtures, and the loop's prompt templates the compiled code reads. */
import { cpSync, existsSync } from 'node:fs';
const from = 'src/adapters/__fixtures__';
if (existsSync(from)) cpSync(from, 'dist/adapters/__fixtures__', { recursive: true });
cpSync('src/loop/prompts', 'dist/loop/prompts', { recursive: true });
