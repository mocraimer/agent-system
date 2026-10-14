#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src', 'ui', 'public');
const destination = join(root, 'dist', 'ui', 'public');

// The UI is an optional sibling deliverable. Keeping this copy step tolerant of
// its absence lets the MCP/CLI package build independently while still making a
// checked-in UI's static files part of the release-shaped dist tree.
if (!existsSync(source)) process.exit(0);

rmSync(destination, { recursive: true, force: true });
mkdirSync(dirname(destination), { recursive: true });
cpSync(source, destination, { recursive: true });
