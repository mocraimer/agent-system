import type { RuntimeId } from '../core/authority.js';
import { CLAUDE_LOCAL_CAPABILITIES } from './claude-local.js';
import { CLAUDE_WEB_CAPABILITIES } from './claude-web.js';
import { CODEX_CLOUD_CAPABILITIES } from './codex-cloud.js';
import { PI_CAPABILITIES } from './pi.js';
import type { RuntimeCapabilities } from './types.js';

/**
 * What a runtime can be told and what it reports back, without building one.
 *
 * Authority decisions need these facts before any adapter exists: whether an
 * approval may name a model at all, and whether a mismatch against one is worth
 * refusing. Asking `adapterFor` would mean constructing a vendor client — reading
 * config, holding a session id — to answer a question about a constant.
 *
 * These are the adapters' own declarations, not a second copy. A runtime that
 * changes what it accepts changes it in one place.
 */
export function capabilitiesFor(runtime: RuntimeId): RuntimeCapabilities {
  switch (runtime) {
    case 'pi-local':
      return PI_CAPABILITIES;
    case 'claude-web':
      return CLAUDE_WEB_CAPABILITIES;
    case 'claude-local':
      return CLAUDE_LOCAL_CAPABILITIES;
    case 'codex-cloud':
      return CODEX_CLOUD_CAPABILITIES;
  }
}
