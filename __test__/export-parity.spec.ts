import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// export-parity.mjs runs in its own Node.js process, without Vitest's module
// transforms, so that require() and import() resolve the package's entry
// points as an application's would.
const SCRIPT = resolve(__dirname, 'export-parity.mjs');

describe('export parity', () => {
  it('exports the declared names from every entry point, through require() and import', () => {
    const output = execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    expect(output).toContain('Export parity OK');
  });
});
