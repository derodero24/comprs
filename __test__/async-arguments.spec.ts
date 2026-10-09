import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import * as comprs from '../index.js';
import {
  brotliCompress,
  brotliCompressAsync,
  brotliCompressWithDict,
  brotliCompressWithDictAsync,
  brotliDecompress,
  brotliDecompressAsync,
  brotliDecompressWithCapacity,
  brotliDecompressWithCapacityAsync,
  brotliDecompressWithDict,
  brotliDecompressWithDictAsync,
  brotliDecompressWithDictWithCapacity,
  brotliDecompressWithDictWithCapacityAsync,
  decompress,
  decompressAsync,
  deflateCompress,
  deflateCompressAsync,
  deflateDecompress,
  deflateDecompressAsync,
  deflateDecompressWithCapacity,
  deflateDecompressWithCapacityAsync,
  gzipCompress,
  gzipCompressAsync,
  gzipDecompress,
  gzipDecompressAsync,
  gzipDecompressWithCapacity,
  gzipDecompressWithCapacityAsync,
  lz4Compress,
  lz4CompressAsync,
  lz4Decompress,
  lz4DecompressAsync,
  lz4DecompressWithCapacity,
  lz4DecompressWithCapacityAsync,
  zstdCompress,
  zstdCompressAsync,
  zstdCompressWithDict,
  zstdCompressWithDictAsync,
  zstdDecompress,
  zstdDecompressAsync,
  zstdDecompressWithCapacity,
  zstdDecompressWithCapacityAsync,
  zstdDecompressWithDict,
  zstdDecompressWithDictAsync,
  zstdDecompressWithDictWithCapacity,
  zstdDecompressWithDictWithCapacityAsync,
  zstdTrainDictionary,
  zstdTrainDictionaryAsync,
} from '../index.js';

// The *Async functions report every error through the Promise they return,
// invalid arguments included, so that callers handle errors in one place: a
// synchronous throw escapes `promise.catch()`. The error is the one that the
// synchronous variant throws for the same arguments.

/** Any function, whatever its parameters. */
type AnyFunction = (...args: never[]) => unknown;

/** Call `fn` with arguments that its type may not allow. */
function callUnchecked(fn: AnyFunction, args: readonly unknown[]): unknown {
  return Reflect.apply(fn, undefined, args);
}

const data = Buffer.from('async argument validation');
const dict = Buffer.from('async argument dictionary');

/** The kinds of parameters that the *Async functions take. */
type Parameter =
  | 'data'
  | 'dict'
  | 'level'
  | 'capacity'
  | 'maxOutputSize'
  | 'samples'
  | 'maxDictSize';

/** A valid value of each parameter, and invalid ones. */
const VALUES: Record<Parameter, { valid: unknown; invalid: readonly unknown[] }> = {
  data: { valid: data, invalid: [undefined, null, 'text', 42, [1, 2, 3], {}] },
  dict: { valid: dict, invalid: [undefined, 'text'] },
  // 99 is out of range for every level and quality.
  level: { valid: 1, invalid: [99, -1.5, Number.NaN, '1', {}] },
  capacity: { valid: 1024, invalid: [undefined, null, -1, 0.5, 2 ** 53, '1024'] },
  maxOutputSize: { valid: 1024, invalid: [-1, 0.5, '1024'] },
  samples: { valid: [data, dict], invalid: [undefined, 'text', ['text'], [data, 42]] },
  maxDictSize: { valid: 4096, invalid: [-1, 2 ** 24 + 1, '4096'] },
};

type AsyncFunctionName = Extract<keyof typeof comprs, `${string}Async`>;

/** Every *Async function, its synchronous variant, and its parameters. */
const ASYNC_FUNCTIONS: Record<
  AsyncFunctionName,
  { fn: AnyFunction; sync: AnyFunction; parameters: readonly Parameter[] }
> = {
  brotliCompressAsync: {
    fn: brotliCompressAsync,
    sync: brotliCompress,
    parameters: ['data', 'level'],
  },
  brotliCompressWithDictAsync: {
    fn: brotliCompressWithDictAsync,
    sync: brotliCompressWithDict,
    parameters: ['data', 'dict', 'level'],
  },
  brotliDecompressAsync: {
    fn: brotliDecompressAsync,
    sync: brotliDecompress,
    parameters: ['data'],
  },
  brotliDecompressWithCapacityAsync: {
    fn: brotliDecompressWithCapacityAsync,
    sync: brotliDecompressWithCapacity,
    parameters: ['data', 'capacity'],
  },
  brotliDecompressWithDictAsync: {
    fn: brotliDecompressWithDictAsync,
    sync: brotliDecompressWithDict,
    parameters: ['data', 'dict'],
  },
  brotliDecompressWithDictWithCapacityAsync: {
    fn: brotliDecompressWithDictWithCapacityAsync,
    sync: brotliDecompressWithDictWithCapacity,
    parameters: ['data', 'dict', 'capacity'],
  },
  decompressAsync: {
    fn: decompressAsync,
    sync: decompress,
    parameters: ['data', 'maxOutputSize'],
  },
  deflateCompressAsync: {
    fn: deflateCompressAsync,
    sync: deflateCompress,
    parameters: ['data', 'level'],
  },
  deflateDecompressAsync: {
    fn: deflateDecompressAsync,
    sync: deflateDecompress,
    parameters: ['data'],
  },
  deflateDecompressWithCapacityAsync: {
    fn: deflateDecompressWithCapacityAsync,
    sync: deflateDecompressWithCapacity,
    parameters: ['data', 'capacity'],
  },
  gzipCompressAsync: {
    fn: gzipCompressAsync,
    sync: gzipCompress,
    parameters: ['data', 'level'],
  },
  gzipDecompressAsync: {
    fn: gzipDecompressAsync,
    sync: gzipDecompress,
    parameters: ['data'],
  },
  gzipDecompressWithCapacityAsync: {
    fn: gzipDecompressWithCapacityAsync,
    sync: gzipDecompressWithCapacity,
    parameters: ['data', 'capacity'],
  },
  lz4CompressAsync: {
    fn: lz4CompressAsync,
    sync: lz4Compress,
    parameters: ['data'],
  },
  lz4DecompressAsync: {
    fn: lz4DecompressAsync,
    sync: lz4Decompress,
    parameters: ['data'],
  },
  lz4DecompressWithCapacityAsync: {
    fn: lz4DecompressWithCapacityAsync,
    sync: lz4DecompressWithCapacity,
    parameters: ['data', 'capacity'],
  },
  zstdCompressAsync: {
    fn: zstdCompressAsync,
    sync: zstdCompress,
    parameters: ['data', 'level'],
  },
  zstdCompressWithDictAsync: {
    fn: zstdCompressWithDictAsync,
    sync: zstdCompressWithDict,
    parameters: ['data', 'dict', 'level'],
  },
  zstdDecompressAsync: {
    fn: zstdDecompressAsync,
    sync: zstdDecompress,
    parameters: ['data'],
  },
  zstdDecompressWithCapacityAsync: {
    fn: zstdDecompressWithCapacityAsync,
    sync: zstdDecompressWithCapacity,
    parameters: ['data', 'capacity'],
  },
  zstdDecompressWithDictAsync: {
    fn: zstdDecompressWithDictAsync,
    sync: zstdDecompressWithDict,
    parameters: ['data', 'dict'],
  },
  zstdDecompressWithDictWithCapacityAsync: {
    fn: zstdDecompressWithDictWithCapacityAsync,
    sync: zstdDecompressWithDictWithCapacity,
    parameters: ['data', 'dict', 'capacity'],
  },
  zstdTrainDictionaryAsync: {
    fn: zstdTrainDictionaryAsync,
    sync: zstdTrainDictionary,
    parameters: ['samples', 'maxDictSize'],
  },
};

/** Argument lists for a function: one invalid argument at a time, then all of them. */
function invalidCalls(parameters: readonly Parameter[]): unknown[][] {
  const valid = parameters.map((parameter) => VALUES[parameter].valid);
  const calls = parameters.flatMap((parameter, index) =>
    VALUES[parameter].invalid.map((value) => valid.with(index, value)),
  );
  // The first invalid argument decides the error, as in the synchronous variant.
  calls.push(parameters.map((parameter) => VALUES[parameter].invalid.at(-1)));
  // A missing first argument.
  calls.push([]);
  return calls;
}

/** What `call` throws. */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('nothing was thrown');
}

/** The code and message of an error that the addon throws. */
function codeAndMessage(error: unknown): { code: unknown; message: string } {
  if (error instanceof Error && 'code' in error) {
    return { code: error.code, message: error.message };
  }
  throw error;
}

/** Call an *Async function, which must return a Promise instead of throwing. */
function callAsync(fn: AnyFunction, args: readonly unknown[]): unknown {
  let promise: unknown;
  expect(() => {
    promise = callUnchecked(fn, args);
  }, inspect(args)).not.toThrow();
  expect(promise, inspect(args)).toBeInstanceOf(Promise);
  return promise;
}

describe('*Async functions with invalid arguments', () => {
  it('should cover every exported *Async function', () => {
    const exported = Object.keys(comprs).filter((name) => name.endsWith('Async'));
    expect(Object.keys(ASYNC_FUNCTIONS).sort()).toEqual(exported.sort());
  });

  it.each(Object.entries(ASYNC_FUNCTIONS))(
    '%s should reject with the error of its synchronous variant',
    async (_name, { fn, sync, parameters }) => {
      for (const args of invalidCalls(parameters)) {
        const expected = codeAndMessage(thrownBy(() => callUnchecked(sync, args)));
        await expect(callAsync(fn, args), inspect(args)).rejects.toThrow(
          expect.objectContaining(expected),
        );
      }
    },
  );

  it('should reject with what reading an argument throws', async () => {
    // Reading the elements of the samples array runs their getters.
    for (const exception of [new Error('getter failed'), 'not an Error']) {
      const samples = [data];
      Object.defineProperty(samples, 0, {
        get() {
          throw exception;
        },
      });
      expect(thrownBy(() => zstdTrainDictionary(samples))).toBe(exception);
      await expect(callAsync(zstdTrainDictionaryAsync, [samples])).rejects.toBe(exception);
    }
  });
});

describe('*Async functions with valid arguments', () => {
  // The arguments are valid, but `data` is not compressed data, so every
  // decompressor fails (`decompressAsync` with an InvalidArg code, the others
  // with GenericFailure), and so does the dictionary training on two short
  // samples. The error of the operation, too, is the one that the
  // synchronous variant throws.
  it.each(Object.entries(ASYNC_FUNCTIONS))(
    '%s should settle as its synchronous variant returns or throws',
    async (_name, { fn, sync, parameters }) => {
      const args = parameters.map((parameter) => VALUES[parameter].valid);
      let expected: unknown;
      try {
        expected = callUnchecked(sync, args);
      } catch (error) {
        await expect(callAsync(fn, args)).rejects.toThrow(
          expect.objectContaining(codeAndMessage(error)),
        );
        return;
      }
      await expect(callAsync(fn, args)).resolves.toEqual(expected);
    },
  );
});
