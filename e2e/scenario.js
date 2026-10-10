// The checks that every fixture runs on the build of @derodero24/comprs that
// its import loads: the native addon in Node.js, Deno and Bun, and the
// WebAssembly build in browsers. Each fixture imports the functions by name,
// as an application does, and passes them in.

/**
 * @typedef {(data: Uint8Array) => Uint8Array} Codec
 * @typedef {(data: Uint8Array) => Promise<Uint8Array>} AsyncCodec
 * @typedef {() => TransformStream<Uint8Array, Uint8Array>} StreamFactory
 */

/**
 * What the checks use from `@derodero24/comprs` and
 * `@derodero24/comprs/streams`, and how they load `@derodero24/comprs/next`.
 *
 * @typedef {object} Comprs
 * @property {Codec} zstdCompress
 * @property {Codec} zstdDecompress
 * @property {Codec} gzipCompress
 * @property {Codec} gzipDecompress
 * @property {Codec} deflateCompress
 * @property {Codec} deflateDecompress
 * @property {Codec} brotliCompress
 * @property {Codec} brotliDecompress
 * @property {Codec} lz4Compress
 * @property {Codec} lz4Decompress
 * @property {Codec} decompress
 * @property {(data: Uint8Array) => string} detectFormat
 * @property {FormatEnum} CompressionFormat
 * @property {(data: Uint8Array) => number} crc32
 * @property {() => string} version
 * @property {StreamFactory} createZstdCompressStream
 * @property {StreamFactory} createDecompressStream
 * @property {() => Promise<AsyncFunctions>} importAsync Load
 *   `@derodero24/comprs` as the fixture does: its ES module namespace, or
 *   what require() returns. It holds the *Async functions, which
 *   browser/app.js imports dynamically.
 * @property {() => Promise<Next>} importNext Load
 *   `@derodero24/comprs/next` as the fixture does. browser/app.js imports it
 *   dynamically too, so that it does not keep the initialisation of the
 *   WebAssembly module in a bundle that drops that of the root entry.
 */

/**
 * What the checks use from `@derodero24/comprs/next`, the unified API.
 *
 * @typedef {Pick<
 *   typeof import('@derodero24/comprs/next'),
 *   'compress' | 'compressSync' | 'decompress' | 'decompressSync' | 'detectFormat' | 'Dictionary'
 * >} Next
 */

/** @typedef {import('@derodero24/comprs/next').ErrorCode} ErrorCode */

/**
 * The members of the `CompressionFormat` enum.
 *
 * @typedef {object} FormatEnum
 * @property {string} Zstd
 * @property {string} Gzip
 * @property {string} Brotli
 * @property {string} Lz4
 * @property {string} Unknown
 */

/**
 * @typedef {object} AsyncFunctions
 * @property {AsyncCodec} gzipCompressAsync
 * @property {AsyncCodec} gzipDecompressAsync
 */

/**
 * Size of the input: more than the memory that the WebAssembly module starts
 * with (1.75 MiB), so that the first call grows the memory, which detaches
 * every view of it that the wasm-bindgen glue holds.
 */
const INPUT_SIZE = 4 * 1024 * 1024;

/** CRC-32 of {@link input}, which crc32() must return in every build. */
const INPUT_CRC32 = 0xe0931310;

/** The formats of the unified API. */
const NEXT_FORMATS = /** @type {const} */ ([
  'zstd',
  'gzip',
  'deflate',
  'deflate-raw',
  'brotli',
  'lz4',
]);

/**
 * Run every check, and throw an Error that names the first one to fail.
 *
 * @param {Comprs} comprs
 * @returns {Promise<string[]>} The checks that passed.
 */
export async function checkPackage(comprs) {
  const data = input();
  /** @type {string[]} */
  const passed = [];
  /**
   * @param {string} name
   * @param {() => void | Promise<void>} check
   */
  const run = async (name, check) => {
    try {
      await check();
    } catch (cause) {
      throw new Error(`${name} failed: ${cause instanceof Error ? cause.message : cause}`, {
        cause,
      });
    }
    passed.push(name);
  };

  /** @type {[string, Codec, Codec][]} */
  const codecs = [
    ['zstd', comprs.zstdCompress, comprs.zstdDecompress],
    ['gzip', comprs.gzipCompress, comprs.gzipDecompress],
    ['deflate', comprs.deflateCompress, comprs.deflateDecompress],
    ['brotli', comprs.brotliCompress, comprs.brotliDecompress],
    ['lz4', comprs.lz4Compress, comprs.lz4Decompress],
  ];
  /** @type {Map<string, Uint8Array>} */
  const compressed = new Map();
  for (const [name, compress, decompress] of codecs) {
    await run(`${name} round trip`, () => {
      const output = compress(data);
      assert(output.byteLength < data.byteLength, 'the output is not smaller than the input');
      assertBytes(decompress(output), data);
      compressed.set(name, output);
    });
  }
  await run('format detection', () => {
    const { CompressionFormat } = comprs;
    /** @type {[string, string][]} */
    const formats = [
      ['zstd', CompressionFormat.Zstd],
      ['gzip', CompressionFormat.Gzip],
      ['brotli', CompressionFormat.Brotli],
      ['lz4', CompressionFormat.Lz4],
    ];
    for (const [name, member] of formats) {
      const output = compressed.get(name) ?? new Uint8Array();
      const format = comprs.detectFormat(output);
      assert(format === name, `detectFormat() returned ${format} for ${name}`);
      assert(format === member, `CompressionFormat has ${member} for ${name}`);
      assertBytes(comprs.decompress(output), data);
    }
    // Raw deflate data has no header to detect.
    const deflate = comprs.detectFormat(compressed.get('deflate') ?? new Uint8Array());
    assert(deflate === CompressionFormat.Unknown, `detectFormat() returned ${deflate} for deflate`);
  });
  await run('corrupt input', () => {
    // Overwrite 16 bytes in the middle of the deflate data.
    const corrupt = comprs.gzipCompress(data.subarray(0, 65536));
    corrupt.fill(0, corrupt.length >> 1, (corrupt.length >> 1) + 16);
    assertThrows(() => comprs.gzipDecompress(corrupt));
  });
  await run('crc32', () => {
    assert(comprs.crc32(data) === INPUT_CRC32, `crc32() returned ${comprs.crc32(data)}`);
  });
  await run('version', () => {
    assert(/^\d+\.\d+\.\d+/.test(comprs.version()), `version() returned ${comprs.version()}`);
  });
  await run('async round trip', async () => {
    const { gzipCompressAsync, gzipDecompressAsync } = await comprs.importAsync();
    assertBytes(await gzipDecompressAsync(await gzipCompressAsync(data)), data);
  });
  await run('no task classes', async () => {
    // napi-rs adds a class to the native binding for every `#[napi]` impl
    // of its Task trait. require() returns the whole binding, and Bun and
    // bundlers list all of it in the ES module namespace, so such a class
    // would be exported although it is not declared and cannot be
    // constructed (#568).
    const tasks = Object.keys(await comprs.importAsync()).filter((name) => name.endsWith('Task'));
    assert(tasks.length === 0, `the entry exports ${tasks.join(', ')}`);
  });
  await run('unified API round trip', async () => {
    const next = await comprs.importNext();
    const sample = data.subarray(0, 65536);
    for (const format of NEXT_FORMATS) {
      const output = next.compressSync(sample, { format });
      assert(
        Object.getPrototypeOf(output) === Uint8Array.prototype,
        `compressSync() returned no plain Uint8Array for ${format}`,
      );
      assertBytes(next.decompressSync(output, { format }), sample);
    }
    const zstd = await next.compress(data, { format: 'zstd' });
    assert(
      next.detectFormat(zstd) === 'zstd',
      `detectFormat() returned ${next.detectFormat(zstd)}`,
    );
    assertBytes(await next.decompress(zstd), data);
  });
  await run('unified API error codes', async () => {
    const next = await comprs.importNext();
    const zlib = next.compressSync(data.subarray(0, 65536), { format: 'deflate' });
    const cut = zlib.subarray(0, zlib.length >> 1);
    assertCode(() => next.decompressSync(cut, { format: 'deflate' }), 'ERR_COMPRS_TRUNCATED');
    assertCode(
      () => next.compressSync(data, { format: 'zstd', level: 23 }),
      'ERR_COMPRS_INVALID_ARG',
    );
    const text = new TextEncoder().encode('not compressed');
    await assertRejects(next.decompress(text), 'ERR_COMPRS_UNKNOWN_FORMAT');
    await assertRejects(
      next.compress(data, { format: 'gzip', level: 10 }),
      'ERR_COMPRS_INVALID_ARG',
    );
  });
  await run('unified API prepared dictionary', async () => {
    // The native addon holds a Dictionary as an External, the WebAssembly
    // build as an object of its glue (#557).
    const next = await comprs.importNext();
    const sample = data.subarray(0, 4096);
    const dictionary = next.Dictionary.from(data.subarray(4096, 20480), { format: 'zstd' });
    const output = next.compressSync(sample, { format: 'zstd', dictionary });
    assertBytes(next.decompressSync(output, { dictionary }), sample);
    const fromAsync = await next.compress(sample, { format: 'zstd', dictionary });
    assertBytes(await next.decompress(fromAsync, { format: 'zstd', dictionary }), sample);
    assertBytes(dictionary.toBytes(), data.subarray(4096, 20480));
    dictionary.close();
    assertCode(
      () => next.compressSync(sample, { format: 'zstd', dictionary }),
      'ERR_COMPRS_INVALID_ARG',
    );
  });
  await run('unified API abort signal', async () => {
    // The native addon withdraws work that no thread has started (#559);
    // the WebAssembly build discards the result of work that is done.
    const next = await comprs.importNext();
    const sample = data.subarray(0, 65536);
    const reason = new Error('no longer needed');
    const controller = new AbortController();
    const pending = next.compress(sample, { format: 'zstd', signal: controller.signal });
    controller.abort(reason);
    await assertRejectsWith(pending, reason);
    await assertRejectsWith(next.decompress(sample, { signal: AbortSignal.abort(reason) }), reason);
    const { signal } = new AbortController();
    const output = await next.compress(sample, { format: 'zstd', signal });
    assertBytes(await next.decompress(output, { signal }), sample);
  });
  await run('stream round trip', async () => {
    const stream = new Blob([data])
      .stream()
      .pipeThrough(comprs.createZstdCompressStream())
      .pipeThrough(comprs.createDecompressStream());
    assertBytes(new Uint8Array(await new Response(stream).arrayBuffer()), data);
  });
  await run('stream chunk transfer', async () => {
    // A reader may transfer a chunk to a worker, which detaches the
    // ArrayBuffer of the chunk. The other chunks must keep their bytes, so
    // each chunk needs an ArrayBuffer of its own.
    const reader = new Blob([data])
      .stream()
      .pipeThrough(comprs.createZstdCompressStream())
      .getReader();
    /** @type {Uint8Array[]} */
    const chunks = [];
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      chunks.push(result.value);
    }
    const [first, ...others] = chunks;
    assert(first !== undefined && others.length > 0, `the stream emitted ${chunks.length} chunks`);
    const { buffer } = first;
    assert(buffer instanceof ArrayBuffer, 'the chunk is not backed by an ArrayBuffer');
    const bytes = first.slice();
    const expected = others.map((chunk) => chunk.slice());
    const moved = structuredClone(first, { transfer: [buffer] });
    assert(first.byteLength === 0, 'the transfer did not detach the chunk');
    assertBytes(moved, bytes);
    for (const [i, chunk] of others.entries()) {
      assertBytes(chunk, expected[i] ?? new Uint8Array());
    }
  });
  return passed;
}

/**
 * Return {@link INPUT_SIZE} bytes of text that compresses about as well as
 * a log file: words picked by a fixed pseudo-random sequence.
 */
function input() {
  const words = ['comprs', 'zstd', 'gzip', 'deflate', 'brotli', 'lz4', 'stream', 'chunk'];
  const encoder = new TextEncoder();
  const data = new Uint8Array(INPUT_SIZE);
  let seed = 1;
  let offset = 0;
  while (offset < data.length) {
    // The high bits of a linear congruential generator are the random ones.
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const word = `${words[seed >>> 29]} ${(seed >>> 16) % 1000}\n`;
    offset += encoder.encodeInto(word, data.subarray(offset)).written;
  }
  return data;
}

/**
 * @param {boolean} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * @param {Uint8Array} actual
 * @param {Uint8Array} expected
 */
function assertBytes(actual, expected) {
  assert(
    actual.byteLength === expected.byteLength,
    `got ${actual.byteLength} bytes, expected ${expected.byteLength}`,
  );
  const index = actual.findIndex((byte, i) => byte !== expected[i]);
  assert(index === -1, `the output differs from the input at byte ${index}`);
}

/** @param {() => unknown} fn */
function assertThrows(fn) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error('the call did not throw');
}

/**
 * Check an error of the unified API: it carries `code`, and it is a
 * TypeError for ERR_COMPRS_INVALID_ARG and a plain Error for every other
 * code.
 *
 * @param {unknown} error
 * @param {ErrorCode} code
 */
function assertCoded(error, code) {
  const expected = code === 'ERR_COMPRS_INVALID_ARG' ? TypeError : Error;
  assert(
    error instanceof Error && Object.getPrototypeOf(error) === expected.prototype,
    `expected a ${expected.name}, got ${error}`,
  );
  const actual = Reflect.get(error, 'code');
  assert(actual === code, `expected the code ${code}, got ${actual}`);
}

/**
 * @param {() => unknown} fn
 * @param {ErrorCode} code
 */
function assertCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assertCoded(error, code);
    return;
  }
  throw new Error(`the call did not throw ${code}`);
}

/**
 * @param {Promise<unknown>} promise
 * @param {ErrorCode} code
 */
async function assertRejects(promise, code) {
  try {
    await promise;
  } catch (error) {
    assertCoded(error, code);
    return;
  }
  throw new Error(`the Promise did not reject with ${code}`);
}

/**
 * Check that `promise` rejects with `reason` itself, as a call whose signal
 * aborted does.
 *
 * @param {Promise<unknown>} promise
 * @param {unknown} reason
 */
async function assertRejectsWith(promise, reason) {
  try {
    await promise;
  } catch (error) {
    assert(error === reason, `the Promise rejected with ${error}, not with the reason`);
    return;
  }
  throw new Error('the Promise did not reject with the reason of the abort');
}
