#!/usr/bin/env node

/**
 * Report the size of the browser WebAssembly binary,
 * browser/comprs-wasm_bg.wasm, as built by scripts/build-wasm-bindgen.js:
 * raw, gzip-compressed (level 9) and brotli-compressed (quality 11), with
 * Node.js's zlib. Browsers download one of the compressed forms, so the gzip
 * size has a budget as well as the raw size. The brotli size has none: at
 * quality 11 it moves by several percent with unrelated changes.
 *
 * The `build-wasm-bindgen` job of .github/workflows/ci.yml runs this after
 * the build, and the `report-wasm-size` job posts its table on pull requests.
 *
 * Usage:
 *   node scripts/wasm-size.mjs [--markdown <file>]
 *
 *   --markdown <file>  Write the report to <file> as a Markdown table too.
 *
 * Exits with 1 when a size is over its budget. Raise the budget in the same
 * pull request as a change that is worth the extra bytes.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const WASM_FILE = 'browser/comprs-wasm_bg.wasm';

// A few percent over the sizes of the build that introduced the budget
// (#586): 1,866,742 bytes raw and 792,050 bytes with gzip.
const BUDGET = { raw: 1_925_000, gzip: 815_000 };

const { values } = parseArgs({ options: { markdown: { type: 'string' } } });

const wasmPath = join(import.meta.dirname, '..', WASM_FILE);
if (!existsSync(wasmPath)) {
  console.error(`${WASM_FILE} not found: build it with \`pnpm run build:wasm-bindgen\` first.`);
  process.exit(1);
}
const wasm = readFileSync(wasmPath);
const rows = [
  { name: 'Raw', size: wasm.length, budget: BUDGET.raw },
  { name: 'gzip (level 9)', size: gzipSync(wasm, { level: 9 }).length, budget: BUDGET.gzip },
  {
    name: 'brotli (quality 11)',
    size: brotliCompressSync(wasm, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: wasm.length,
      },
    }).length,
    budget: undefined,
  },
];

/** @param {number} n */
const bytes = (n) => n.toLocaleString('en-US');
const over = rows.flatMap(({ name, size, budget }) =>
  budget !== undefined && size > budget ? [{ name, excess: size - budget }] : [],
);

const table = [
  `| \`${WASM_FILE}\` | Bytes | Budget |`,
  '| --- | ---: | ---: |',
  ...rows.map(
    (row) =>
      `| ${row.name} | ${bytes(row.size)} | ${row.budget === undefined ? '-' : bytes(row.budget)} |`,
  ),
].join('\n');
const verdict =
  over.length === 0
    ? 'Within budget.'
    : `Over budget: ${over.map((row) => `${row.name} by ${bytes(row.excess)} bytes`).join(', ')}. The budget is in scripts/wasm-size.mjs.`;

console.log(`${table}\n\n${verdict}`);
if (values.markdown !== undefined) {
  writeFileSync(values.markdown, `### WASM binary size\n\n${table}\n\n${verdict}\n`);
}
if (over.length > 0) {
  process.exitCode = 1;
}
