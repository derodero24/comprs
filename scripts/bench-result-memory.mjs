#!/usr/bin/env node

/**
 * Measure what the results of the synchronous functions cost in time and
 * memory, in a loop that never yields to the event loop ("tight") and in one
 * that yields after every call ("yield"), as a server does. It sets
 * `SYNC_COPY_LIMIT` in crates/core/src/convert.rs: results of up to that
 * size are copied into memory that V8 allocates, larger ones are returned as
 * external buffers, which Node.js frees only on a later turn of the event
 * loop (#560, #677, #679).
 *
 * Each measurement runs in a process of its own, so that memory from one
 * does not count towards the next. It calls `zstdDecompress()` on a frame
 * that decodes to the size, and reports the time per call and the growth of
 * the resident set size (RSS) over the calls.
 *
 * Usage:
 *   node scripts/bench-result-memory.mjs [--addon <file>] [--sizes <KiB,...>]
 *     [--calls <n>] [--markdown <file>]
 *
 *   --addon <file>     The addon to load, such as a `.node` file built
 *                      elsewhere. Defaults to the package root (index.js).
 *   --sizes <KiB,...>  The result sizes in KiB. Defaults to
 *                      128,256,512,1024,2048,4096.
 *   --calls <n>        Calls per measurement. Defaults to 200.
 *   --markdown <file>  Write the results to <file> as a Markdown table too.
 *
 * To compare the copy with external buffers, build the addon a second time
 * with `SYNC_COPY_LIMIT` set to 0, which returns every result as an external
 * buffer, and run this script on each build with --addon. The figures depend
 * on the allocator: glibc, musl and the Windows heap each need their own run.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/** @typedef {'tight' | 'yield'} Mode */
/** @typedef {{ mode: Mode, sizeKiB: number, usPerCall: number, rssGrowthMiB: number }} Result */
/** @typedef {{ zstdCompress(data: Buffer, level?: number): Buffer, zstdDecompress(data: Buffer): Buffer }} Addon */

/** @type {readonly Mode[]} */
const MODES = ['tight', 'yield'];
const WARMUP_CALLS = 20;

const { values } = parseArgs({
  options: {
    addon: { type: 'string' },
    sizes: { type: 'string', default: '128,256,512,1024,2048,4096' },
    calls: { type: 'string', default: '200' },
    markdown: { type: 'string' },
    // Internal: run one measurement and print it as JSON.
    child: { type: 'string' },
  },
});

/**
 * Parse a positive integer option, or exit with an error that names it.
 *
 * @param {string} name
 * @param {string} value
 * @returns {number}
 */
function positiveInteger(name, value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    console.error(`--${name} must be a positive integer, got ${JSON.stringify(value)}`);
    process.exit(2);
  }
  return number;
}

/**
 * Load the addon from `file`, or the package root.
 *
 * @param {string | undefined} file
 * @returns {Addon}
 */
function loadAddon(file) {
  const require = createRequire(import.meta.url);
  return require(file === undefined ? join(import.meta.dirname, '..', 'index.js') : resolve(file));
}

/**
 * Data of `size` bytes that zstd compresses well but not trivially: a 4 KiB
 * pseudo-random block, repeated.
 *
 * @param {number} size
 * @returns {Buffer}
 */
function testData(size) {
  const block = Buffer.alloc(4096);
  let state = 1;
  for (let i = 0; i < block.length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    block[i] = state >>> 24;
  }
  const data = Buffer.alloc(size);
  for (let offset = 0; offset < size; offset += block.length) {
    block.copy(data, offset);
  }
  return data;
}

/** @returns {Promise<void>} */
const nextTurn = () => new Promise((resolveTurn) => setImmediate(resolveTurn));

/**
 * Run one measurement in this process.
 *
 * @param {Addon} addon
 * @param {Mode} mode
 * @param {number} sizeKiB
 * @param {number} calls
 * @returns {Promise<Result>}
 */
async function measure(addon, mode, sizeKiB, calls) {
  const size = sizeKiB * 1024;
  const frame = addon.zstdCompress(testData(size), 3);
  /** @returns {void} */
  const call = () => {
    if (addon.zstdDecompress(frame).length !== size) {
      throw new Error(`zstdDecompress() returned the wrong size for ${sizeKiB} KiB`);
    }
  };
  for (let i = 0; i < WARMUP_CALLS; i++) {
    call();
    if (mode === 'yield') {
      await nextTurn();
    }
  }
  await nextTurn();
  const startRss = process.memoryUsage.rss();
  let peakRss = startRss;
  const start = process.hrtime.bigint();
  for (let i = 0; i < calls; i++) {
    call();
    if (mode === 'yield') {
      await nextTurn();
    }
    if (i % 16 === 15) {
      peakRss = Math.max(peakRss, process.memoryUsage.rss());
    }
  }
  const elapsed = process.hrtime.bigint() - start;
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
  return {
    mode,
    sizeKiB,
    usPerCall: Number(elapsed) / 1000 / calls,
    rssGrowthMiB: (peakRss - startRss) / 2 ** 20,
  };
}

/**
 * Run one measurement in a new process.
 *
 * @param {Mode} mode
 * @param {number} sizeKiB
 * @param {number} calls
 * @returns {Result}
 */
function measureInChild(mode, sizeKiB, calls) {
  const args = [import.meta.filename, '--child', `${mode}:${sizeKiB}`, '--calls', String(calls)];
  if (values.addon !== undefined) {
    args.push('--addon', values.addon);
  }
  const child = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (child.status !== 0) {
    throw new Error(`The measurement of ${mode} ${sizeKiB} KiB failed:\n${child.stderr}`);
  }
  return /** @type {Result} */ (JSON.parse(child.stdout));
}

const calls = positiveInteger('calls', values.calls);

if (values.child !== undefined) {
  const [mode, sizeKiB] = values.child.split(':');
  if (mode !== 'tight' && mode !== 'yield') {
    throw new Error(`Unknown mode ${JSON.stringify(mode)}`);
  }
  const result = await measure(
    loadAddon(values.addon),
    mode,
    positiveInteger('child', sizeKiB ?? ''),
    calls,
  );
  process.stdout.write(JSON.stringify(result));
} else {
  const sizes = values.sizes.split(',').map((size) => positiveInteger('sizes', size.trim()));
  const lines = [
    `Node.js ${process.version}, ${process.platform}-${process.arch}, ${calls} calls each`,
    '',
    '| Loop | Result size | Time per call | RSS growth |',
    '| --- | ---: | ---: | ---: |',
  ];
  console.log(lines.join('\n'));
  for (const mode of MODES) {
    for (const sizeKiB of sizes) {
      const { usPerCall, rssGrowthMiB } = measureInChild(mode, sizeKiB, calls);
      const line = `| ${mode} | ${sizeKiB} KiB | ${usPerCall.toFixed(0)} µs | ${rssGrowthMiB.toFixed(0)} MiB |`;
      lines.push(line);
      console.log(line);
    }
  }
  if (values.markdown !== undefined) {
    writeFileSync(values.markdown, `${lines.join('\n')}\n`);
  }
}
