/**
 * A minimal flag parser.
 *
 * Deliberately not a dependency: the CLI's surface is a fixed set of long flags,
 * and a parser library would be more code to audit than the twenty lines it saves.
 */
export interface ParsedArgs {
  command: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags = new Map<string, string | true>();
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) break;
    command.push(a);
  }
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export function requireString(flags: Map<string, string | true>, name: string): string {
  const v = flags.get(name);
  if (typeof v !== 'string' || v.trim() === '') {
    throw new UsageError(`--${name} is required and must have a value.`);
  }
  return v;
}

export function optionalString(
  flags: Map<string, string | true>,
  name: string,
): string | undefined {
  const v = flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

export function requireNumber(flags: Map<string, string | true>, name: string): number {
  const raw = requireString(flags, name);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number, got "${raw}".`);
  return n;
}

export function optionalNumber(
  flags: Map<string, string | true>,
  name: string,
): number | undefined {
  const raw = optionalString(flags, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number, got "${raw}".`);
  return n;
}

export function list(flags: Map<string, string | true>, name: string): string[] {
  const raw = optionalString(flags, name);
  if (raw === undefined) return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

export function flag(flags: Map<string, string | true>, name: string): boolean {
  return flags.get(name) === true || flags.get(name) === 'true';
}
