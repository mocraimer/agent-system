import { readFileSync } from 'node:fs';

/** Content-addressed build stamp, written after compilation, never inferred from activation. */
export interface BuildIdentity {
  digest: string;
  revision: string | null;
  dirty: boolean;
  builtAt: string;
}

function readBuild(): Readonly<BuildIdentity> | null {
  try {
    const value = JSON.parse(readFileSync(new URL('../build-identity.json', import.meta.url), 'utf8')) as BuildIdentity;
    if (!/^[a-f0-9]{64}$/.test(value.digest) || typeof value.builtAt !== 'string' || typeof value.dirty !== 'boolean' ||
        !(value.revision === null || typeof value.revision === 'string')) return null;
    return Object.freeze(value);
  } catch { return null; }
}

/** Captured once. Rebuilding files or activating metadata cannot relabel this process. */
export const loadedBuild = readBuild();

export function buildIdentityView(selectedCoordinator?: string) {
  const onDisk = readBuild();
  return {
    loaded: loadedBuild,
    onDisk,
    selectedCoordinator: selectedCoordinator ?? null,
    loadedMatchesDisk: loadedBuild && onDisk ? loadedBuild.digest === onDisk.digest : null,
    loadedMatchesSelected: loadedBuild && selectedCoordinator
      ? selectedCoordinator === loadedBuild.digest || (!loadedBuild.dirty && selectedCoordinator === loadedBuild.revision)
      : null,
  };
}
