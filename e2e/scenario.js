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
 * `@derodero24/comprs/streams`.
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
 * @property {(data: Uint8Array) => number} crc32
 * @property {() => string} version
 * @property {StreamFactory} createZstdCompressStream
 * @property {StreamFactory} createDecompressStream
 * @property {() => Promise<AsyncFunctions>} importAsync Import the *Async
 *   functions, which browser/app.js imports dynamically.
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
    // Raw deflate data has no header to detect.
    for (const name of ['zstd', 'gzip', 'brotli', 'lz4']) {
      const output = compressed.get(name) ?? new Uint8Array();
      const format = comprs.detectFormat(output);
      assert(format === name, `detectFormat() returned ${format} for ${name}`);
      assertBytes(comprs.decompress(output), data);
    }
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
  await run('stream round trip', async () => {
    const stream = new Blob([data])
      .stream()
      .pipeThrough(comprs.createZstdCompressStream())
      .pipeThrough(comprs.createDecompressStream());
    assertBytes(new Uint8Array(await new Response(stream).arrayBuffer()), data);
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
