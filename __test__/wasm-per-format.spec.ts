import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The per-format WebAssembly builds of the unified API (#342), which
 * scripts/build-wasm-bindgen.js builds next to the full build, as
 * browser/comprs-wasm-<family>.js. Each has the functions of
 * crates/wasm/src/next.rs for the formats of its family, and rejects the
 * others.
 */

const FAMILIES = {
  zstd: ['zstd'],
  gzip: ['gzip', 'deflate', 'deflate-raw'],
  brotli: ['brotli'],
  lz4: ['lz4'],
} as const;

type Family = keyof typeof FAMILIES;

const FORMATS = ['zstd', 'gzip', 'deflate', 'deflate-raw', 'brotli', 'lz4'] as const;

/** The functions of a glue module that the tests call. */
interface Glue {
  initSync(module: { module: Uint8Array }): unknown;
  nextBuiltFormats(): string[];
  nextCompress(data: Uint8Array, format: string): Uint8Array;
  nextDecompress(data: Uint8Array, format?: string): Uint8Array;
  nextDetectFormat(data: Uint8Array): string | null;
  nextDetectPrefix(data: Uint8Array, isFinal: boolean): string | null | undefined;
  nextTrainDictionary(samples: Uint8Array[], maxSize?: number): Uint8Array;
  NextDictionary: new (bytes: Uint8Array, format: string) => { free(): void };
}

function isGlue(value: unknown): value is Glue {
  return (
    typeof value === 'object' &&
    value !== null &&
    [
      'initSync',
      'nextBuiltFormats',
      'nextCompress',
      'nextDecompress',
      'nextDetectFormat',
      'nextDetectPrefix',
      'nextTrainDictionary',
      'NextDictionary',
    ].every((name) => typeof Reflect.get(value, name) === 'function')
  );
}

function browserFile(name: string): string {
  return resolve(__dirname, '../browser', name);
}

const HAS_BUILDS = ['comprs-wasm', ...Object.keys(FAMILIES).map((f) => `comprs-wasm-${f}`)].every(
  (name) => existsSync(browserFile(`${name}_bg.wasm`)),
);

/**
 * Load the glue of a build, and instantiate its module from the file next
 * to it. The glue has declarations only after the build, so it is imported
 * by a path that the type check does not resolve.
 */
async function loadGlue(name: string): Promise<Glue> {
  const path: string = browserFile(`${name}.js`);
  const glue: unknown = await import(path);
  if (!isGlue(glue)) {
    throw new Error(`${name}.js lacks a function of the unified API`);
  }
  glue.initSync({ module: readFileSync(browserFile(`${name}_bg.wasm`)) });
  return glue;
}

/** The error that `call` throws. */
function thrown(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('the call did not throw');
}

const DATA = new TextEncoder().encode('comprs per-format builds '.repeat(64));

describe.skipIf(!HAS_BUILDS)('the per-format WebAssembly builds', () => {
  let full: Glue;
  const builds = new Map<Family, Glue>();
  beforeAll(async () => {
    full = await loadGlue('comprs-wasm');
    for (const family of Object.keys(FAMILIES) as Family[]) {
      builds.set(family, await loadGlue(`comprs-wasm-${family}`));
    }
  });

  function build(family: Family): Glue {
    const glue = builds.get(family);
    if (glue === undefined) {
      throw new Error(`no build for ${family}`);
    }
    return glue;
  }

  it('lists every format in the full build', () => {
    expect(full.nextBuiltFormats()).toEqual(FORMATS);
  });

  describe.each(Object.keys(FAMILIES) as Family[])('%s', (family) => {
    const built: readonly string[] = FAMILIES[family];

    it('lists the formats of its family', () => {
      expect(build(family).nextBuiltFormats()).toEqual(built);
    });

    it.each(built)('gives the bytes of the full build in %s', (format) => {
      const compressed = build(family).nextCompress(DATA, format);
      expect(compressed).toEqual(full.nextCompress(DATA, format));
      expect(build(family).nextDecompress(compressed, format)).toEqual(DATA);
    });

    it.each(FORMATS.filter((format) => !built.includes(format)))('rejects %s', (format) => {
      const message = `this build of comprs does not include ${format}`;
      const glue = build(family);
      const compressed = full.nextCompress(DATA, format);
      for (const call of [
        () => glue.nextCompress(DATA, format),
        () => glue.nextDecompress(compressed, format),
      ]) {
        const error = thrown(call);
        expect(error).toBeInstanceOf(TypeError);
        expect(error).toMatchObject({ message, code: 'ERR_COMPRS_INVALID_ARG' });
      }
    });

    it('prepares dictionaries only for its formats', () => {
      for (const format of ['zstd', 'brotli']) {
        if (built.includes(format)) {
          new (build(family).NextDictionary)(DATA, format).free();
        } else {
          expect(() => new (build(family).NextDictionary)(DATA, format)).toThrow(
            `this build of comprs does not include ${format}`,
          );
        }
      }
    });
  });

  it('trains dictionaries only in the zstd build', () => {
    const samples = Array.from({ length: 64 }, (_, i) =>
      new TextEncoder().encode(`{"id":${i},"name":"sample ${i}","tags":["a","b"]}`),
    );
    expect(build('zstd').nextTrainDictionary(samples, 1024).length).toBeGreaterThan(0);
    for (const family of ['gzip', 'brotli', 'lz4'] as const) {
      expect(() => build(family).nextTrainDictionary(samples, 1024)).toThrow(
        'this build of comprs does not include zstd',
      );
    }
  });

  describe('detection', () => {
    it('finds the formats with a magic number in every build', () => {
      for (const format of ['zstd', 'gzip', 'lz4']) {
        const compressed = full.nextCompress(DATA, format);
        for (const glue of builds.values()) {
          expect(glue.nextDetectFormat(compressed)).toBe(format);
        }
      }
    });

    it('decompresses only the detected formats of the build', () => {
      const compressed = full.nextCompress(DATA, 'gzip');
      expect(build('gzip').nextDecompress(compressed)).toEqual(DATA);
      expect(() => build('zstd').nextDecompress(compressed)).toThrow(
        'this build of comprs does not include gzip',
      );
    });

    it('finds zlib only in builds with gzip, and brotli only in builds with brotli', () => {
      const zlib = full.nextCompress(DATA, 'deflate');
      const brotli = full.nextCompress(DATA, 'brotli');
      expect(build('gzip').nextDetectFormat(zlib)).toBe('deflate');
      expect(build('brotli').nextDetectFormat(brotli)).toBe('brotli');
      for (const family of ['zstd', 'brotli', 'lz4'] as const) {
        expect(build(family).nextDetectFormat(zlib)).toBeNull();
      }
      for (const family of ['zstd', 'lz4'] as const) {
        expect(build(family).nextDetectFormat(brotli)).toBeNull();
      }
    });

    it('needs more of the start of the data while it could change the answer', () => {
      const gzip = full.nextCompress(DATA, 'gzip');
      expect(full.nextDetectPrefix(gzip.subarray(0, 2), false)).toBeUndefined();
      expect(full.nextDetectPrefix(gzip.subarray(0, 2), true)).toBeNull();
      expect(full.nextDetectPrefix(gzip.subarray(0, 3), false)).toBe('gzip');
      expect(build('lz4').nextDetectPrefix(new Uint8Array([0x01, 0x02, 0x03]), false)).toBeNull();
    });
  });
});
