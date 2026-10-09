import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// export-parity.mjs runs in its own Node.js process, without Vitest's module
// transforms, so that require() and import() resolve the package's entry
// points as an application's would.
const SCRIPT = resolve(__dirname, 'export-parity.mjs');
// How long the script may run. Vitest fails a test that outlasts its own
// timeout (5 s by default) even while it waits in execFileSync, so the test
// gets twice this.
const PROCESS_TIMEOUT = 30_000;

const require = createRequire(__filename);

/** The names of an entry point's exports that end in `Task`. */
function taskNames(entry: object): string[] {
  return Object.keys(entry).filter((key) => key.endsWith('Task'));
}

describe('export parity', { timeout: 2 * PROCESS_TIMEOUT }, () => {
  it('exports the declared names from every entry point, through require() and import', () => {
    const output = execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROCESS_TIMEOUT,
    });
    expect(output).toContain('Export parity OK');
  });

  // napi-rs adds a class to the native binding for every `#[napi]` impl of
  // its Task trait, and require() returns the whole binding, so such a class
  // would be listed there although index.d.ts does not declare it and it
  // cannot be constructed (#568).
  it('exports no task classes through require()', () => {
    const root: object = require('../index.js');
    expect(taskNames(root)).toEqual([]);
    expect('ZstdCompressTask' in root).toBe(false);
  });

  // Node.js gives import only the names that cjs-module-lexer finds in
  // index.js, its explicit `module.exports.name =` assignments, so a task
  // class never reached the namespace there, and the check of the import in
  // export-parity.mjs passes under Node.js either way. Vitest's interop, like
  // Bun and bundlers, lists every property of the exports object instead, so
  // this test fails when the binding has task classes, as do
  // `bun __test__/export-parity.mjs` and the Package E2E check of
  // e2e/scenario.js under Bun.
  it('exports no task classes through import', async () => {
    const namespace: object = await import('../index.mjs');
    expect(taskNames(namespace)).toEqual([]);
    expect('ZstdCompressTask' in namespace).toBe(false);
  });
});
