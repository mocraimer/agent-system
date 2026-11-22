/** Public product seam; execution and authority remain in the selected coordinator build. */
export { adapterFor, createCoordinatorCommands } from './commands.js';
export type * from './commands.js';
export type { DispatchInput, DispatchResult } from './adapters/types.js';
export type { CurrentAuthoritySettings } from './core/interactive.js';
