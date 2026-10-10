import { describe, expect, it } from 'vitest';
import {
  brotliCompressWithDict,
  brotliDecompressWithDict,
  zstdCompressWithDict,
  zstdDecompressWithDict,
  zstdTrainDictionary,
} from '../index.js';
import {
  compress,
  compressSync,
  type DecompressOptions,
  Dictionary,
  type DictionaryOptions,
  decompress,
  decompressSync,
  type ErrorCode,
} from '../next/index.js';

// The prepared dictionaries of the unified API, @derodero24/comprs/next
// (#557): Dictionary.from() digests a zstd dictionary once, for every call
// that takes it as its `dictionary`, where the bytes of a dictionary are
// digested on every call. next-parity.spec.ts compares the browser build.

/** A JSON message of about 110 bytes, like those of #557. */
function message(i: number): Uint8Array {
  const user = (i * 7919) % 100_000;
  return encoder.encode(
    JSON.stringify({
      id: i,
      user: `user_${user}`,
      email: `user${user}@example.com`,
      ts: 1_700_000_000 + i * 37,
      event: ['alpha', 'bravo', 'charlie', 'delta'][i % 4],
      active: i % 3 === 0,
    }),
  );
}

const encoder = new TextEncoder();
/** A zstd dictionary trained on messages other than those compressed. */
const trained = new Uint8Array(
  zstdTrainDictionary(
    Array.from({ length: 2000 }, (_, i) => message(100_000 + i)),
    8192,
  ),
);
/** Bytes for a brotli dictionary, which brotli takes as they are. */
const brotliBytes = encoder.encode(
  '{"id":0,"user":"user_","email":"@example.com","event":"alpha","active":false}'.repeat(4),
);
const messages = Array.from({ length: 8 }, (_, i) => message(i));
const text = encoder.encode('The unified API prepares dictionaries once. '.repeat(500));

/** `size` bytes of the messages from message(`first`) on, the last cut. */
function lines(size: number, first: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let offset = 0, i = first; offset < size; i++) {
    const line = message(i);
    bytes.set(line.subarray(0, size - offset), offset);
    offset += line.length;
  }
  return bytes;
}

/**
 * zstd dictionaries of 32 KiB and 110 KiB of raw content: bytes without the
 * header of a trained dictionary, which zstd takes as they are.
 */
const raw32 = lines(32 * 1024, 300_000);
const raw110 = lines(110 * 1024, 400_000);

/** The bytes of a dictionary for `format`. */
function bytesFor(format: DictionaryOptions['format']): Uint8Array {
  return format === 'zstd' ? trained : brotliBytes;
}

/** `bytes`, a Buffer of the root entry, as a plain Uint8Array to compare. */
function plain(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/** The error that `call` throws. */
function thrown(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/** The error that `promise` rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the Promise to reject');
}

/** Expect `error` to be an error of the API with `code` and `message`. */
function expectCoded(error: unknown, code: ErrorCode, message: string): void {
  expect(error).toBeInstanceOf(code === 'ERR_COMPRS_INVALID_ARG' ? TypeError : Error);
  expect(error).toMatchObject({ code, message });
  if (code !== 'ERR_COMPRS_INVALID_ARG') {
    expect(error).not.toBeInstanceOf(TypeError);
  }
}

describe('Dictionary.from', () => {
  it.each(['zstd', 'brotli'] as const)('prepares a %s dictionary', (format) => {
    const bytes = bytesFor(format);
    const dictionary = Dictionary.from(bytes, { format });
    expect(dictionary).toBeInstanceOf(Dictionary);
    expect(dictionary.format).toBe(format);
    expect(dictionary.byteLength).toBe(bytes.byteLength);
    const copy = dictionary.toBytes();
    expect(Object.getPrototypeOf(copy)).toBe(Uint8Array.prototype);
    expect(copy).toEqual(bytes);
    // Each call returns a copy of its own.
    copy.fill(0);
    expect(dictionary.toBytes()).toEqual(bytes);
    dictionary.close();
  });

  it('copies the bytes', () => {
    const bytes = Uint8Array.from(trained);
    const dictionary = Dictionary.from(bytes, { format: 'zstd' });
    const expected = compressSync(messages[0] ?? text, { format: 'zstd', dictionary });
    bytes.fill(0);
    expect(dictionary.toBytes()).toEqual(trained);
    expect(compressSync(messages[0] ?? text, { format: 'zstd', dictionary })).toEqual(expected);
    expect(decompressSync(expected, { dictionary })).toEqual(messages[0]);
  });

  it('reads every kind of input', () => {
    const shared = new SharedArrayBuffer(trained.byteLength);
    new Uint8Array(shared).set(trained);
    for (const bytes of [
      trained.buffer.slice(trained.byteOffset, trained.byteOffset + trained.byteLength),
      new DataView(shared),
      shared,
      Buffer.from(trained),
    ]) {
      const dictionary = Dictionary.from(bytes, { format: 'zstd' });
      expect(dictionary.toBytes()).toEqual(trained);
      expect(dictionary.byteLength).toBe(trained.byteLength);
    }
  });

  it('takes no public constructor', () => {
    const error = thrown(() => Reflect.construct(Dictionary, []));
    expectCoded(
      error,
      'ERR_COMPRS_INVALID_ARG',
      'Dictionary cannot be constructed: create one with Dictionary.from()',
    );
  });

  it.each([
    [
      'options that are no object',
      () => Reflect.apply(Dictionary.from, Dictionary, [trained]),
      'options must be an object',
    ],
    [
      'a format without dictionaries',
      () => Reflect.apply(Dictionary.from, Dictionary, [trained, { format: 'gzip' }]),
      'format must be one of zstd, brotli',
    ],
    [
      'a level of the wrong type',
      () => Reflect.apply(Dictionary.from, Dictionary, [trained, { format: 'zstd', level: '3' }]),
      'level must be a number',
    ],
    [
      'bytes of the wrong type',
      () => Reflect.apply(Dictionary.from, Dictionary, ['bytes', { format: 'zstd' }]),
      'bytes must be an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
    ],
    [
      'empty bytes',
      () => Dictionary.from(new Uint8Array(0), { format: 'zstd' }),
      'dictionary must not be empty',
    ],
    [
      'a zstd level out of range',
      () => Dictionary.from(trained, { format: 'zstd', level: 23 }),
      'zstd compression level must be an integer between -131072 and 22',
    ],
    [
      'a level for brotli',
      () => Dictionary.from(brotliBytes, { format: 'brotli', level: 5 }),
      'level applies to zstd dictionaries only',
    ],
  ])('rejects %s', (_, call, message) => {
    expectCoded(thrown(call), 'ERR_COMPRS_INVALID_ARG', message);
  });

  it('fails for a zstd dictionary that zstd cannot digest', () => {
    // A trained dictionary cut short inside its entropy tables.
    const error = thrown(() => Dictionary.from(trained.subarray(0, 16), { format: 'zstd' }));
    expect(error).toMatchObject({ code: 'ERR_COMPRS_OPERATION_FAILED' });
    expect(error).not.toBeInstanceOf(TypeError);
  });
});

describe('compression with a Dictionary', () => {
  it('writes zstd that zstdDecompressWithDict reads, and reads what zstdCompressWithDict writes', async () => {
    const dictionary = Dictionary.from(trained, { format: 'zstd' });
    for (const input of [...messages, text]) {
      const options = { format: 'zstd', dictionary } as const;
      const compressed = compressSync(input, options);
      expect(compressed).toEqual(await compress(input, options));
      expect(plain(zstdDecompressWithDict(compressed, trained))).toEqual(input);
      const fromRoot = zstdCompressWithDict(input, trained);
      expect(decompressSync(fromRoot, options)).toEqual(input);
      expect(await decompress(fromRoot, options)).toEqual(input);
      // The bytes of the dictionary decompress what it compressed.
      expect(decompressSync(compressed, { format: 'zstd', dictionary: trained })).toEqual(input);
    }
  });

  it('writes the bytes of brotliCompressWithDict, which brotliDecompressWithDict reads', async () => {
    const dictionary = Dictionary.from(brotliBytes, { format: 'brotli' });
    for (const level of [undefined, 1, 9]) {
      for (const input of [messages[1] ?? text, text]) {
        const options = { format: 'brotli', dictionary, level } as const;
        const expected = plain(brotliCompressWithDict(input, brotliBytes, level));
        expect(compressSync(input, options)).toEqual(expected);
        expect(await compress(input, options)).toEqual(expected);
        expect(plain(brotliDecompressWithDict(expected, brotliBytes))).toEqual(input);
        expect(decompressSync(expected, { dictionary })).toEqual(input);
        expect(await decompress(expected, { dictionary })).toEqual(input);
      }
    }
  });

  it('compresses at its level by default, and at any other level', () => {
    const input = messages[2] ?? text;
    const at19 = Dictionary.from(trained, { format: 'zstd', level: 19 });
    const at1 = Dictionary.from(trained, { format: 'zstd', level: 1 });
    const default19 = compressSync(input, { format: 'zstd', dictionary: at19 });
    expect(compressSync(input, { format: 'zstd', dictionary: at19, level: 19 })).toEqual(default19);
    // Level 0 selects 3, as without a dictionary, not the level of the
    // Dictionary, which digests level 3 on its first use.
    const at3 = Dictionary.from(trained, { format: 'zstd', level: 3 });
    const default3 = compressSync(input, { format: 'zstd', dictionary: at3 });
    expect(default3).not.toEqual(default19);
    expect(compressSync(input, { format: 'zstd', dictionary: at19, level: 0 })).toEqual(default3);
    at3.close();
    // A level other than the prepared one compresses as a dictionary
    // prepared for that level does.
    for (const dictionary of [at19, at1]) {
      for (const level of [1, -5, 7, 19]) {
        const compressed = compressSync(input, { format: 'zstd', dictionary, level });
        const prepared = Dictionary.from(trained, { format: 'zstd', level });
        expect(compressSync(input, { format: 'zstd', dictionary: prepared })).toEqual(compressed);
        expect(plain(zstdDecompressWithDict(compressed, trained))).toEqual(input);
        prepared.close();
      }
    }
    // Large input, which zstd compresses with parameters for its size.
    const compressed = compressSync(text, { format: 'zstd', dictionary: at1, level: 12 });
    expect(decompressSync(compressed, { dictionary: at19 })).toEqual(text);
  });

  it('compresses with zstd workers', async () => {
    // More than the 512 KiB that zstd compresses without its workers.
    const large = encoder.encode('zstd compresses this with worker threads. '.repeat(16_000));
    const dictionary = Dictionary.from(trained, { format: 'zstd' });
    const compressed = await compress(large, { format: 'zstd', dictionary, workers: 2 });
    expect(decompressSync(compressed, { dictionary })).toEqual(large);
  });

  it('takes the bytes of a dictionary as before', () => {
    const input = messages[3] ?? text;
    const compressed = compressSync(input, { format: 'zstd', dictionary: trained });
    expect(compressed).toEqual(plain(zstdCompressWithDict(input, trained)));
    expect(decompressSync(compressed, { format: 'zstd', dictionary: trained })).toEqual(input);
  });
});

describe('the zstd frames of a Dictionary', () => {
  // zstd compresses an input with the parameters that a Dictionary was
  // digested for, unless the input has at least 128 KiB and at least 6
  // times as many bytes as the dictionary, its header included
  // (ZSTD_USE_CDICT_PARAMS_SRCSIZE_CUTOFF and _DICTSIZE_MULTIPLIER of zstd
  // 1.5.7): such an input gets parameters for its size. Up to level 8,
  // smaller inputs of at most 512 KiB get the frames that
  // zstdCompressWithDict() writes with the bytes. Other inputs can get other
  // frames, so the tests only decompress those with the bytes. Above level
  // 8, zstd sizes its window and splits blocks otherwise with a Dictionary,
  // which changes no frame of the messages or `text`, but can change those
  // of other inputs below the cutoff.
  it.each([-5, 1, 3, 19])(
    'are those of zstdCompressWithDict for the messages at level %i',
    (level) => {
      const dictionary = Dictionary.from(trained, { format: 'zstd', level });
      for (const input of [...messages, text]) {
        expect(compressSync(input, { format: 'zstd', dictionary })).toEqual(
          plain(zstdCompressWithDict(input, trained, level)),
        );
      }
      dictionary.close();
    },
  );

  /**
   * Dictionaries, with inputs just below the size from which zstd takes
   * parameters for the input or from which the window can differ, and
   * inputs at or above it.
   */
  const cutoffs: [name: string, bytes: Uint8Array, below: Uint8Array[], above: Uint8Array[]][] = [
    // 128 KiB, more than 6 times the 8 KiB of `trained`.
    ['trained', trained, [lines(131_071, 0)], [lines(131_072, 0)]],
    // 6 times 32 KiB, 196,608 bytes, more than 128 KiB.
    ['raw32', raw32, [lines(131_072, 0), lines(196_607, 0)], [lines(196_608, 0)]],
    // 6 times 110 KiB, 675,840 bytes, more than 512 KiB, where the windows
    // of the frames can differ below the cutoff too.
    ['raw110', raw110, [lines(524_288, 0)], [lines(524_289, 0), lines(675_840, 0)]],
  ];

  it.each([-5, 1, 3])('are those of zstdCompressWithDict below the cutoff at level %i', (level) => {
    for (const [name, bytes, below, above] of cutoffs) {
      const dictionary = Dictionary.from(bytes, { format: 'zstd', level });
      for (const input of below) {
        const compressed = compressSync(input, { format: 'zstd', dictionary });
        expect(compressed, `${name}, ${input.length} bytes`).toEqual(
          plain(zstdCompressWithDict(input, bytes, level)),
        );
      }
      for (const input of above) {
        const compressed = compressSync(input, { format: 'zstd', dictionary });
        expect(
          plain(zstdDecompressWithDict(compressed, bytes)),
          `${name}, ${input.length} bytes`,
        ).toEqual(input);
      }
      dictionary.close();
    }
  });
});

describe('decompression with a Dictionary', () => {
  it.each(['zstd', 'brotli'] as const)(
    'defaults to the format of a %s dictionary',
    async (format) => {
      const dictionary = Dictionary.from(bytesFor(format), { format });
      const compressed = compressSync(text, { format, dictionary });
      expect(decompressSync(compressed, { dictionary })).toEqual(text);
      expect(decompressSync(compressed, { format: 'auto', dictionary })).toEqual(text);
      expect(await decompress(compressed, { dictionary })).toEqual(text);
      expect(
        decompressSync(compressed, { format, dictionary, maxOutputSize: text.length }),
      ).toEqual(text);
    },
  );

  it("still needs a format for the bytes of a dictionary, as with 'auto'", () => {
    const compressed = compressSync(text, { format: 'zstd', dictionary: trained });
    const optionsWithout: DecompressOptions[] = [
      { dictionary: trained },
      { format: 'auto', dictionary: trained },
    ];
    for (const options of optionsWithout) {
      expectCoded(
        thrown(() => decompressSync(compressed, options)),
        'ERR_COMPRS_INVALID_ARG',
        'pass `format` to decompress with a dictionary',
      );
    }
  });
});

describe('a Dictionary of the wrong format', () => {
  const zstdDictionary = Dictionary.from(trained, { format: 'zstd' });
  const brotliDictionary = Dictionary.from(brotliBytes, { format: 'brotli' });
  const zstdData = compressSync(text, { format: 'zstd', dictionary: zstdDictionary });

  it.each([
    [
      'compression in brotli with a zstd dictionary',
      () => compressSync(text, { format: 'brotli', dictionary: zstdDictionary }),
      () => compress(text, { format: 'brotli', dictionary: zstdDictionary }),
      'this Dictionary is for zstd',
    ],
    [
      'compression in zstd with a brotli dictionary',
      () => compressSync(text, { format: 'zstd', dictionary: brotliDictionary }),
      () => compress(text, { format: 'zstd', dictionary: brotliDictionary }),
      'this Dictionary is for brotli',
    ],
    [
      'decompression of zstd with a brotli dictionary',
      () => decompressSync(zstdData, { format: 'zstd', dictionary: brotliDictionary }),
      () => decompress(zstdData, { format: 'zstd', dictionary: brotliDictionary }),
      'this Dictionary is for brotli',
    ],
    [
      'compression in gzip',
      () => compressSync(text, { format: 'gzip', dictionary: zstdDictionary }),
      () => compress(text, { format: 'gzip', dictionary: zstdDictionary }),
      'gzip does not support dictionaries',
    ],
  ])('fails %s', async (_, sync, async, message) => {
    expectCoded(thrown(sync), 'ERR_COMPRS_INVALID_ARG', message);
    expectCoded(await rejection(async()), 'ERR_COMPRS_INVALID_ARG', message);
  });

  it('fails data of the other format', () => {
    const error = thrown(() => decompressSync(zstdData, { dictionary: brotliDictionary }));
    expect(error).toMatchObject({ code: 'ERR_COMPRS_CORRUPT_DATA' });
  });

  it('is told apart from an object that only looks like a Dictionary', () => {
    const fake = Object.create(Dictionary.prototype);
    for (const dictionary of [fake, new Proxy(zstdDictionary, {})]) {
      expectCoded(
        thrown(() => compressSync(text, { format: 'zstd', dictionary })),
        'ERR_COMPRS_INVALID_ARG',
        'dictionary must be a Dictionary or an ArrayBuffer, SharedArrayBuffer or ArrayBufferView',
      );
    }
  });
});

describe('close()', () => {
  it('makes later calls fail', async () => {
    const dictionary = Dictionary.from(trained, { format: 'zstd' });
    const compressed = compressSync(text, { format: 'zstd', dictionary });
    dictionary.close();
    const closed = 'this Dictionary is closed';
    expectCoded(
      thrown(() => compressSync(text, { format: 'zstd', dictionary })),
      'ERR_COMPRS_INVALID_ARG',
      closed,
    );
    expectCoded(
      await rejection(compress(text, { format: 'zstd', dictionary })),
      'ERR_COMPRS_INVALID_ARG',
      closed,
    );
    expectCoded(
      thrown(() => decompressSync(compressed, { dictionary })),
      'ERR_COMPRS_INVALID_ARG',
      closed,
    );
    expectCoded(
      await rejection(decompress(compressed, { dictionary })),
      'ERR_COMPRS_INVALID_ARG',
      closed,
    );
    expectCoded(
      thrown(() => dictionary.toBytes()),
      'ERR_COMPRS_INVALID_ARG',
      closed,
    );
    // Closing again does nothing; the format and the size stay.
    dictionary.close();
    expect(dictionary.format).toBe('zstd');
    expect(dictionary.byteLength).toBe(trained.byteLength);
  });

  it('lets the calls that started finish', async () => {
    const dictionary = Dictionary.from(trained, { format: 'zstd' });
    const expected = compressSync(text, { format: 'zstd', dictionary });
    const compressing = compress(text, { format: 'zstd', dictionary });
    const decompressing = decompress(expected, { dictionary });
    // A level other than the prepared one, which the call prepares.
    const atAnotherLevel = compress(text, { format: 'zstd', dictionary, level: 9 });
    dictionary.close();
    expect(await compressing).toEqual(expected);
    expect(await decompressing).toEqual(text);
    expect(plain(zstdDecompressWithDict(await atAnotherLevel, trained))).toEqual(text);
  });

  it('is [Symbol.dispose]()', () => {
    const dictionary = Dictionary.from(brotliBytes, { format: 'brotli' });
    expect(dictionary[Symbol.dispose]).toBe(dictionary.close);
    expect(Object.keys(dictionary)).toEqual(['format', 'byteLength']);
    dictionary[Symbol.dispose]();
    expectCoded(
      thrown(() => dictionary.toBytes()),
      'ERR_COMPRS_INVALID_ARG',
      'this Dictionary is closed',
    );
  });

  it('runs at the end of the scope of a using declaration', () => {
    let escaped: Dictionary | undefined;
    {
      using dictionary = Dictionary.from(trained, { format: 'zstd' });
      escaped = dictionary;
      expect(dictionary.toBytes()).toEqual(trained);
    }
    expect(() => escaped?.toBytes()).toThrow('this Dictionary is closed');
  });
});
