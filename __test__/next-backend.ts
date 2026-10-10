import { createRequire } from 'node:module';
import type * as BackendModule from '../next/backend.js';

const require = createRequire(__filename);

/** Whether `value` is next/backend.js, as its declarations describe it. */
function isBackendModule(value: unknown): value is typeof BackendModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'backend') === 'function' &&
    typeof Reflect.get(value, 'setBackend') === 'function'
  );
}

/**
 * next/backend.js, whose backend a test wraps, as the modules of next/
 * share it. They load each other with the require() of Node.js, and so does
 * this module, but Vitest would load an import of next/backend.js as a
 * module of its own, without a backend.
 */
export function backendModule(): typeof BackendModule {
  const loaded: unknown = require('../next/backend.js');
  if (!isBackendModule(loaded)) {
    throw new Error('next/backend.js exports no backend');
  }
  return loaded;
}
