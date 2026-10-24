import { createRequire } from 'node:module';
import type * as BackendModule from '../next/backend.js';

const require = createRequire(__filename);

/** A backend.js of the unified API: next/backend.js or browser/next/backend.js. */
type BackendModuleLike = Pick<typeof BackendModule, 'backendOf' | 'replaceBackend'>;

/** The Backend interface of next/backend.js. */
type Backend = BackendModule.Backend;

/** Whether `value` is next/backend.js, as its declarations describe it. */
function isBackendModule(value: unknown): value is typeof BackendModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'backendOf') === 'function' &&
    typeof Reflect.get(value, 'replaceBackend') === 'function'
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

/**
 * Run `body` with `wrap(original)` in place of `original`, the backend that
 * the entry point registered for zstd, for every format whose backend it
 * is, and put `original` back afterwards. `module` is the backend.js whose
 * registry holds it: next/backend.js by default.
 */
export async function withBackend(
  wrap: (original: Backend) => Backend,
  body: () => Promise<void>,
  module: BackendModuleLike = backendModule(),
): Promise<void> {
  const original = module.backendOf('zstd');
  if (original === undefined) {
    throw new Error('no backend is registered: import the entry point first');
  }
  const wrapped = wrap(original);
  module.replaceBackend(original, wrapped);
  try {
    await body();
  } finally {
    module.replaceBackend(wrapped, original);
  }
}
