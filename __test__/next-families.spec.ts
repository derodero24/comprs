import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as next from '../next/index.js';
import { pseudoRandomBytes, ROWS } from './detect-fixtures.js';

// The entry points of the families of formats, @derodero24/comprs/next/zstd,
// /gzip, /brotli and /lz4 (#342): each includes the formats of its family
// alone, with the native addon in Node.js and the WebAssembly build of the
// family in browsers, and the functions of a page that loads several of
// them route each format to the entry point that registered it. Each
// scenario runs in a Node.js process of its own, which loads the entry
// points through the package name, as a consumer does, and with the browser
// condition for the WebAssembly builds. The functions of the entry point of
// every format, ./next, are the reference.

const ROOT = resolve(__dirname, '..');

/** The time that one scenario may take, building nothing. */
const PROCESS_TIMEOUT = 60_000;

/** The WebAssembly builds of the families, which `pnpm test` does not build. */
const HAS_FAMILY_BUILDS = ['zstd', 'gzip', 'brotli', 'lz4'].every((family) =>
  existsSync(resolve(ROOT, `browser/comprs-wasm-${family}_bg.wasm`)),
);

/** The full WebAssembly build. */
const HAS_FULL_BUILD = existsSync(resolve(ROOT, 'browser/comprs-wasm_bg.wasm'));

const FORMATS = ['zstd', 'gzip', 'deflate', 'deflate-raw', 'brotli', 'lz4'] as const;

type Format = (typeof FORMATS)[number];

/** Data that compresses, and 64 KiB of data that does not. */
const TEXT = Uint8Array.from(ROWS);
const RANDOM = Uint8Array.from(pseudoRandomBytes(7, 64 * 1024));

/** TEXT in each format, as the entry point of every format compresses it. */
const COMPRESSED: Record<Format, Uint8Array> = Object.fromEntries(
  FORMATS.map((format) => [format, next.compressSync(TEXT, { format })]),
) as Record<Format, Uint8Array>;

/**
 * Data whose format detection decides late: RANDOM in brotli, which does
 * not decode to more bytes than it holds until the end, and in zlib.
 */
const LATE: Record<'brotli' | 'deflate', Uint8Array> = {
  brotli: next.compressSync(RANDOM, { format: 'brotli' }),
  deflate: next.compressSync(RANDOM, { format: 'deflate' }),
};

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** An error as a scenario reports it. */
interface ReportedError {
  name: string;
  code: unknown;
  message: string;
}

/**
 * The prelude of each scenario: the fixtures, and helpers that report
 * results and errors as JSON. `load(family)` imports the entry point of a
 * family, or of every format for `undefined`.
 */
const PRELUDE = `
  const fixtures = ${JSON.stringify({
    text: base64(TEXT),
    random: base64(RANDOM),
    compressed: Object.fromEntries(FORMATS.map((format) => [format, base64(COMPRESSED[format])])),
    late: { brotli: base64(LATE.brotli), deflate: base64(LATE.deflate) },
  })};
  const bytes = (text) => new Uint8Array(Buffer.from(text, 'base64'));
  const text = bytes(fixtures.text);
  const random = bytes(fixtures.random);
  const compressed = Object.fromEntries(
    Object.entries(fixtures.compressed).map(([format, data]) => [format, bytes(data)]),
  );
  const late = { brotli: bytes(fixtures.late.brotli), deflate: bytes(fixtures.late.deflate) };
  const encode = (data) => Buffer.from(data).toString('base64');
  const report = (error) => ({ name: error.name, code: error.code, message: error.message });
  const attempt = (fn) => {
    try {
      return { value: fn() };
    } catch (error) {
      return { error: report(error) };
    }
  };
  const settle = async (promise) => {
    try {
      return { value: await promise };
    } catch (error) {
      return { error: report(error) };
    }
  };
  const load = (family) =>
    import(family === undefined ? '@derodero24/comprs/next' : '@derodero24/comprs/next/' + family);
  // Decompress data through a DecompressionStream, written in chunks of
  // \`size\` bytes, and report the output or the error.
  const throughStream = async (api, format, data, size) => {
    const stream = new api.DecompressionStream(format);
    const writer = stream.writable.getWriter();
    const output = new Response(stream.readable).arrayBuffer();
    const writes = [];
    for (let start = 0; start < data.length || start === 0; start += size) {
      writes.push(writer.write(data.subarray(start, start + size)));
      if (data.length === 0) break;
    }
    writes.push(writer.close());
    const [result] = await Promise.allSettled([output, ...writes]);
    return result.status === 'fulfilled'
      ? { value: encode(new Uint8Array(result.value)) }
      : { error: report(result.reason) };
  };
`;

/**
 * Run `body`, which ends with an expression whose value it reports, after
 * the prelude, in a Node.js process of its own, with the browser condition
 * if `browser`, and return the value.
 */
function scenario(body: string, browser: boolean): unknown {
  const serveFiles = `
    import { readFile } from 'node:fs/promises';
    globalThis.fetch = async (input) =>
      new Response(await readFile(new URL(String(input))), {
        headers: { 'content-type': 'application/wasm' },
      });`;
  const source = `${PRELUDE}
    const result = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(result));`;
  const result = spawnSync(
    process.execPath,
    [
      ...(browser
        ? [
            '--conditions=browser',
            '--import',
            `data:text/javascript,${encodeURIComponent(serveFiles)}`,
          ]
        : []),
      '--input-type=module',
      // The source holds the fixtures, too long for an argument: standard
      // input takes it.
      '-',
    ],
    {
      cwd: ROOT,
      input: source,
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`the scenario failed: ${result.error?.message ?? result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

/** The error that a format of an entry point that was not loaded fails with. */
function notLoaded(format: Format): ReportedError {
  const family = format === 'deflate' || format === 'deflate-raw' ? 'gzip' : format;
  return {
    name: 'TypeError',
    code: 'ERR_COMPRS_INVALID_ARG',
    message: `${format} is not loaded: import @derodero24/comprs/next/${family}, or @derodero24/comprs/next for every format`,
  };
}

const UNKNOWN_FORMAT: ReportedError = {
  name: 'Error',
  code: 'ERR_COMPRS_UNKNOWN_FORMAT',
  message: 'unable to detect the compression format; pass `format`',
};

/** The scenarios, in Node.js and, with the WebAssembly builds, in browsers. */
const RUNTIMES = [
  { name: 'Node.js', browser: false, skip: false },
  { name: 'browsers', browser: true, skip: !HAS_FAMILY_BUILDS },
] as const;

describe.each(RUNTIMES)('the entry points of the families in $name', ({ browser, skip }) => {
  it.skipIf(skip)('include the formats of their family alone', { timeout: PROCESS_TIMEOUT }, () => {
    const result = scenario(
      `
      const zstd = await load('zstd');
      return {
        compressed: encode(zstd.compressSync(text, { format: 'zstd' })),
        roundTrip: encode(zstd.decompressSync(compressed.zstd)),
        asyncRoundTrip: encode(await zstd.decompress(await zstd.compress(text, { format: 'zstd' }))),
        trained:
          zstd.trainDictionarySync(
            Array.from({ length: 64 }, (_, i) => text.subarray(i * 512, (i + 1) * 512)),
            { maxSize: 1024 },
          ).length > 0,
        stream: await throughStream(zstd, 'auto', compressed.zstd, 1000),
        byteStream: await throughStream(zstd, 'auto', compressed.zstd.subarray(0, 64), 1),
        // A format of another family.
        gzip: attempt(() => zstd.compressSync(text, { format: 'gzip' })),
        gzipAsync: await settle(zstd.compress(text, { format: 'gzip' })),
        gzipStream: attempt(() => new zstd.CompressionStream('gzip')),
        brotliDictionary: attempt(() => zstd.Dictionary.from(text, { format: 'brotli' })),
        // Data of another family, which detection still finds.
        detected: zstd.detectFormat(compressed.gzip),
        autoGzip: attempt(() => zstd.decompressSync(compressed.gzip)),
        autoGzipStream: await throughStream(zstd, 'auto', compressed.gzip, 1000),
        // brotli data, which only a backend with the brotli decoder detects:
        // the native addon has every decoder, the zstd WebAssembly build not.
        autoBrotli: attempt(() => zstd.decompressSync(compressed.brotli)),
        unknown: attempt(() => zstd.decompressSync(random)),
        empty: attempt(() => zstd.decompressSync(new Uint8Array(0))),
        emptyStream: await throughStream(zstd, 'auto', new Uint8Array(0), 1),
        rawDictionary: attempt(() => zstd.decompressSync(compressed.zstd, { dictionary: text })),
      };`,
      browser,
    );
    expect(result).toEqual({
      compressed: base64(COMPRESSED.zstd),
      roundTrip: base64(TEXT),
      asyncRoundTrip: base64(TEXT),
      trained: true,
      stream: { value: base64(TEXT) },
      byteStream: expect.objectContaining({
        error: expect.objectContaining({ code: 'ERR_COMPRS_TRUNCATED' }),
      }),
      gzip: { error: notLoaded('gzip') },
      gzipAsync: { error: notLoaded('gzip') },
      gzipStream: { error: notLoaded('gzip') },
      brotliDictionary: { error: notLoaded('brotli') },
      detected: 'gzip',
      autoGzip: { error: notLoaded('gzip') },
      autoGzipStream: { error: notLoaded('gzip') },
      autoBrotli: { error: browser ? UNKNOWN_FORMAT : notLoaded('brotli') },
      unknown: { error: UNKNOWN_FORMAT },
      empty: { error: UNKNOWN_FORMAT },
      emptyStream: { error: UNKNOWN_FORMAT },
      rawDictionary: {
        error: {
          name: 'TypeError',
          code: 'ERR_COMPRS_INVALID_ARG',
          message: 'pass `format` to decompress with a dictionary',
        },
      },
    });
  });

  it.skipIf(skip)(
    'together, compress and detect every format as the entry point of every format does',
    { timeout: PROCESS_TIMEOUT },
    () => {
      const result = scenario(
        `
        const apis = {};
        for (const family of ['zstd', 'gzip', 'brotli', 'lz4']) {
          apis[family] = await load(family);
        }
        const api = (format) =>
          apis[format === 'deflate' || format === 'deflate-raw' ? 'gzip' : format];
        const formats = ${JSON.stringify(FORMATS)};
        const detectable = formats.filter((format) => format !== 'deflate-raw');
        const samples = [
          ...Object.values(compressed),
          late.brotli,
          late.deflate,
          random,
          new Uint8Array(0),
          compressed.gzip.subarray(0, 2),
        ];
        return {
          compressed: Object.fromEntries(
            formats.map((format) => [format, encode(api(format).compressSync(text, { format }))]),
          ),
          roundTrips: Object.fromEntries(
            formats.map((format) => [
              format,
              encode(api(format).decompressSync(api(format).compressSync(text, { format }), { format })),
            ]),
          ),
          // Every entry point routes each format to its own family.
          crossed: encode(apis.lz4.decompressSync(compressed.zstd)),
          detected: samples.map((sample) => apis.zstd.detectFormat(sample) ?? null),
          auto: Object.fromEntries(
            detectable.map((format) => [format, attempt(() => encode(apis.lz4.decompressSync(compressed[format])))]),
          ),
          late: {
            brotli: attempt(() => encode(apis.zstd.decompressSync(late.brotli))),
            deflate: attempt(() => encode(apis.zstd.decompressSync(late.deflate))),
          },
          streams: Object.fromEntries(
            await Promise.all(
              detectable.map(async (format) => [
                format,
                [
                  await throughStream(apis.zstd, 'auto', compressed[format], 1),
                  await throughStream(apis.zstd, 'auto', compressed[format], 7),
                  await throughStream(apis.zstd, 'auto', compressed[format], 1 << 20),
                ],
              ]),
            ),
          ),
          lateStreams: [
            await throughStream(apis.zstd, 'auto', late.brotli, 4096),
            await throughStream(apis.zstd, 'auto', late.deflate, 4096),
          ],
          unknownStream: await throughStream(apis.zstd, 'auto', random, 4096),
        };`,
        browser,
      );
      const detectable = FORMATS.filter((format) => format !== 'deflate-raw');
      const samples = [
        ...Object.values(COMPRESSED),
        LATE.brotli,
        LATE.deflate,
        RANDOM,
        new Uint8Array(0),
        COMPRESSED.gzip.subarray(0, 2),
      ];
      const ok = { value: base64(TEXT) };
      expect(result).toEqual({
        // lz4_flex writes other frames on wasm32 (next-parity.spec.ts).
        compressed: Object.fromEntries(
          FORMATS.map((format) => [
            format,
            browser && format === 'lz4' ? expect.any(String) : base64(COMPRESSED[format]),
          ]),
        ),
        roundTrips: Object.fromEntries(FORMATS.map((format) => [format, base64(TEXT)])),
        crossed: base64(TEXT),
        detected: samples.map((sample) => next.detectFormat(sample) ?? null),
        auto: Object.fromEntries(detectable.map((format) => [format, ok])),
        late: { brotli: { value: base64(RANDOM) }, deflate: { value: base64(RANDOM) } },
        streams: Object.fromEntries(detectable.map((format) => [format, [ok, ok, ok]])),
        lateStreams: [{ value: base64(RANDOM) }, { value: base64(RANDOM) }],
        unknownStream: { error: UNKNOWN_FORMAT },
      });
    },
  );

  it.skipIf(skip || (browser && !HAS_FULL_BUILD))(
    'leave the formats that they registered to them when the entry point of every format follows',
    { timeout: PROCESS_TIMEOUT },
    () => {
      const result = scenario(
        `
        const zstd = await load('zstd');
        const all = await load(undefined);
        const dictionary = zstd.Dictionary.from(text.subarray(0, 4096), { format: 'zstd' });
        return {
          gzip: encode(all.decompressSync(zstd.compressSync(text, { format: 'zstd' }))),
          viaZstd: encode(zstd.decompressSync(all.compressSync(text, { format: 'gzip' }))),
          detected: all.detectFormat(compressed.brotli),
          stream: await throughStream(all, 'auto', compressed.brotli, 1000),
          // A Dictionary goes to the backend that prepared it.
          dictionary: encode(
            all.decompressSync(all.compressSync(text, { format: 'zstd', dictionary }), {
              dictionary,
            }),
          ),
        };`,
        browser,
      );
      expect(result).toEqual({
        gzip: base64(TEXT),
        viaZstd: base64(TEXT),
        detected: 'brotli',
        stream: { value: base64(TEXT) },
        dictionary: base64(TEXT),
      });
    },
  );
});
