#!/usr/bin/env node

/**
 * Report the size of each browser WebAssembly binary that
 * scripts/build-wasm-bindgen.js builds: the full build,
 * browser/comprs-wasm_bg.wasm, and the per-format builds of the unified API,
 * browser/comprs-wasm-<family>_bg.wasm (#342). Each size is given raw,
 * gzip-compressed (level 9) and brotli-compressed (quality 11), with
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
 * Exits with 1 when a size is over its budget, or a binary is missing. Raise
 * the budget in the same pull request as a change that is worth the extra
 * bytes.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

/**
 * @typedef {object} Build
 * @property {string} file The binary, relative to the repository.
 * @property {{ raw: number, gzip: number }} budget Its budgets, in bytes.
 */

/** @type {readonly Build[]} */
const BUILDS = [
  // A few percent over the sizes of the build that introduced the budget
  // (#586): 1,866,742 bytes raw and 792,050 bytes with gzip. The stream
  // classes of `@derodero24/comprs/next` (#344) raised it to 1,940,000 and
  // 822,000 bytes; it went back once the brotli encoders shared one
  // allocator (#707), which made the binary 85,658 bytes smaller raw and
  // 18,099 bytes with gzip. Moving brotli to libbrotli (#563) brought the
  // build down to 1,515,659 bytes raw and 566,722 bytes with gzip, and the
  // budget with it.
  { file: 'browser/comprs-wasm_bg.wasm', budget: { raw: 1_560_000, gzip: 585_000 } },
  // About 5% over the sizes of the builds that introduced them (#342):
  // zstd 533,577 and 159,949 bytes, gzip 177,339 and 76,097, brotli 829,581
  // and 337,431, lz4 106,554 and 42,402.
  { file: 'browser/comprs-wasm-zstd_bg.wasm', budget: { raw: 560_000, gzip: 168_000 } },
  { file: 'browser/comprs-wasm-gzip_bg.wasm', budget: { raw: 186_000, gzip: 80_000 } },
  { file: 'browser/comprs-wasm-brotli_bg.wasm', budget: { raw: 870_000, gzip: 350_000 } },
  { file: 'browser/comprs-wasm-lz4_bg.wasm', budget: { raw: 112_000, gzip: 44_000 } },
];

const { values } = parseArgs({ options: { markdown: { type: 'string' } } });

const root = join(import.meta.dirname, '..');
const missing = BUILDS.filter(({ file }) => !existsSync(join(root, file)));
if (missing.length > 0) {
  console.error(
    `${missing.map(({ file }) => file).join(', ')} not found: build them with \`pnpm run build:wasm-bindgen\` first.`,
  );
  process.exit(1);
}

/** @param {number} n */
const bytes = (n) => n.toLocaleString('en-US');

/** @type {string[]} */
const over = [];
const rows = BUILDS.map(({ file, budget }) => {
  const wasm = readFileSync(join(root, file));
  const raw = wasm.length;
  const gzip = gzipSync(wasm, { level: 9 }).length;
  const brotli = brotliCompressSync(wasm, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: wasm.length,
    },
  }).length;
  if (raw > budget.raw) {
    over.push(`${file} raw by ${bytes(raw - budget.raw)} bytes`);
  }
  if (gzip > budget.gzip) {
    over.push(`${file} with gzip by ${bytes(gzip - budget.gzip)} bytes`);
  }
  return `| \`${file}\` | ${bytes(raw)} | ${bytes(budget.raw)} | ${bytes(gzip)} | ${bytes(budget.gzip)} | ${bytes(brotli)} |`;
});

const table = [
  '| Binary | Raw | Budget | gzip (level 9) | Budget | brotli (quality 11) |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...rows,
].join('\n');
const verdict =
  over.length === 0
    ? 'Within budget.'
    : `Over budget: ${over.join(', ')}. The budgets are in scripts/wasm-size.mjs.`;

console.log(`${table}\n\n${verdict}`);
if (values.markdown !== undefined) {
  writeFileSync(values.markdown, `### WASM binary size\n\n${table}\n\n${verdict}\n`);
}
if (over.length > 0) {
  process.exitCode = 1;
}
