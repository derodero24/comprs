import { execFileSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CompressOptions } from '../next/index.js';
import * as next from '../next/index.js';
import { backendModule } from './next-backend.js';

// The `signal` option of the async functions of the unified API,
// @derodero24/comprs/next (#559): an aborted call rejects with the reason
// of its signal, at once if no thread of the libuv pool has started its
// work, which the pool then skips. next-parity.spec.ts checks the browser
// build.

const encoder = new TextEncoder();
const text = encoder.encode('comprs withdraws work that is no longer needed. '.repeat(400));
const zstdText = next.compressSync(text, { format: 'zstd' });
const samples = Array.from({ length: 200 }, (_, i) =>
  encoder.encode(JSON.stringify({ id: i, name: `item ${i}`, tags: ['a', 'b'] })),
);

/** The async functions, each called with `signal`. */
const CALLS: [name: string, call: (signal: unknown) => Promise<unknown>][] = [
  ['compress', (signal) => call(next.compress, text, { format: 'zstd', signal })],
  ['decompress', (signal) => call(next.decompress, zstdText, { signal })],
  ['trainDictionary', (signal) => call(next.trainDictionary, samples, { maxSize: 4096, signal })],
];

/**
 * `fn` called with `args`, whose types the tests do not check: a signal may
 * be of the wrong type, or an object that only looks like an AbortSignal.
 */
function call(fn: (...args: never[]) => Promise<unknown>, ...args: unknown[]): Promise<unknown> {
  const result: unknown = Reflect.apply(fn, undefined, args);
  if (!(result instanceof Promise)) throw new Error('expected a Promise');
  return result;
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

/** Whether `promise` settles before the event loop turns. */
function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
  const settled = promise.then(
    () => true,
    () => true,
  );
  const later = new Promise<boolean>((resolve) => setImmediate(() => resolve(false)));
  return Promise.race([settled, later]);
}

/** A call of a function of the backend, and what it returned. */
interface BackendCall {
  name: string;
  args: unknown[];
  result?: unknown;
}

/**
 * Run `body` with a backend that records every call of a function of the
 * backend in `calls` and passes it on, or answers it with `answer` if that
 * returns something other than `undefined`.
 */
async function withBackendSpy(
  body: (calls: BackendCall[]) => Promise<void>,
  answer: (name: string) => unknown = () => undefined,
): Promise<void> {
  const { backend, setBackend } = backendModule();
  const original = backend();
  const calls: BackendCall[] = [];
  setBackend(
    new Proxy(original, {
      get(target, key, receiver): unknown {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof key !== 'string' || typeof value !== 'function') return value;
        return (...args: unknown[]): unknown => {
          const call: BackendCall = { name: key, args };
          calls.push(call);
          call.result = answer(key) ?? Reflect.apply(value, target, args);
          return call.result;
        };
      },
    }),
  );
  try {
    await body(calls);
  } finally {
    setBackend(original);
  }
}

describe('the signal option of ./next', () => {
  it.each(CALLS)(
    'makes %s reject with the reason of an aborted signal, before the backend',
    async (_, abortable) => {
      await withBackendSpy(async (calls) => {
        const reason = new Error('aborted before the call');
        expect(await rejection(abortable(AbortSignal.abort(reason)))).toBe(reason);
        // Without a reason, AbortSignal.abort() makes a DOMException its reason.
        const signal = AbortSignal.abort();
        expect(await rejection(abortable(signal))).toBe(signal.reason);
        expect(calls).toEqual([]);
      });
    },
  );

  it.each(CALLS)(
    'makes %s reject with the reason of an abort while it runs',
    async (_, abortable) => {
      const controller = new AbortController();
      const reason = new Error('aborted during the call');
      const promise = abortable(controller.signal);
      controller.abort(reason);
      expect(await rejection(promise)).toBe(reason);
    },
  );

  it.each(CALLS)('makes %s reject with any reason, as it is', async (_, abortable) => {
    // An abort may give any value as its reason, which the call rejects
    // with: it carries no code.
    const controller = new AbortController();
    const promise = abortable(controller.signal);
    controller.abort('reason');
    expect(await rejection(promise)).toBe('reason');
  });

  it('passes the backend a Withdrawal of the call, never the signal', async () => {
    // napi-rs would take a signal over by assigning its onabort property,
    // and leaks native memory for each signal that it converts.
    await withBackendSpy(async (calls) => {
      const { signal } = new AbortController();
      for (const [, abortable] of CALLS) await abortable(signal);
      expect(calls.map(({ name }) => name)).toEqual([
        'createWithdrawal',
        'compressAsync',
        'createWithdrawal',
        'decompressAsync',
        'createWithdrawal',
        'trainDictionaryAsync',
      ]);
      for (let i = 0; i < calls.length; i += 2) {
        const withdrawal = calls[i]?.result;
        expect(withdrawal).toBeTypeOf('object');
        expect(calls[i + 1]?.args.at(-1)).toBe(withdrawal);
      }
      expect(signal.onabort).toBeNull();
    });
  });

  it('passes the backend no Withdrawal without a signal', async () => {
    await withBackendSpy(async (calls) => {
      for (const [, abortable] of CALLS) await abortable(undefined);
      expect(calls).toHaveLength(3);
      for (const { args } of calls) expect(args.at(-1)).toBeUndefined();
    });
  });

  it('rejects at once when the backend withdraws the work', async () => {
    // Work that no thread has started: the backend's Promise settles only
    // when a thread reaches the work, and never here.
    await withBackendSpy(
      async (calls) => {
        const controller = new AbortController();
        const reason = new Error('aborted in the queue');
        const promise = next.compress(text, { format: 'zstd', signal: controller.signal });
        controller.abort(reason);
        expect(await rejection(promise)).toBe(reason);
        const [created, , withdrawn] = calls;
        expect(withdrawn?.name).toBe('withdraw');
        expect(withdrawn?.args).toEqual([created?.result]);
      },
      (name) => {
        if (name === 'compressAsync') return new Promise<never>(() => {});
        return name === 'withdraw' ? true : undefined;
      },
    );
  });

  it('waits for work that has started, and then rejects', async () => {
    // As with fetch(), a call that settles after the abort rejects, and its
    // result is discarded: here the backend cannot withdraw the work, which
    // resolves after the abort.
    let finish = (_: Uint8Array): void => {};
    const work = new Promise<Uint8Array>((resolve) => {
      finish = resolve;
    });
    await withBackendSpy(
      async () => {
        const controller = new AbortController();
        const reason = new Error('aborted while it runs');
        const promise = next.compress(text, { format: 'zstd', signal: controller.signal });
        controller.abort(reason);
        expect(await settlesSoon(promise)).toBe(false);
        finish(zstdText);
        expect(await rejection(promise)).toBe(reason);
      },
      (name) => {
        if (name === 'compressAsync') return work;
        return name === 'withdraw' ? false : undefined;
      },
    );
  });

  it('rejects a call whose work settled before the abort, but that had not settled', async () => {
    // The backend resolves at once, and the caller aborts before the call
    // settles.
    await withBackendSpy(
      async () => {
        const controller = new AbortController();
        const reason = new Error('aborted after the work');
        const promise = next.compress(text, { format: 'zstd', signal: controller.signal });
        controller.abort(reason);
        expect(await rejection(promise)).toBe(reason);
      },
      (name) => {
        if (name === 'compressAsync') return Promise.resolve(zstdText);
        return name === 'withdraw' ? false : undefined;
      },
    );
  });

  it('keeps the value of a call that resolved before the abort', async () => {
    const controller = new AbortController();
    const result = await next.compress(text, { format: 'zstd', signal: controller.signal });
    controller.abort(new Error('too late'));
    expect(result).toEqual(zstdText);
    expect(next.decompressSync(result)).toEqual(text);
  });

  it.each(['zstd', 'brotli'] as const)(
    'passes a %s Dictionary and a signal on together',
    async (format) => {
      // The backend takes the Withdrawal right after the handle of the
      // Dictionary: a call that mixed them up would fail or drop the
      // Dictionary.
      using dictionary = next.Dictionary.from(text.subarray(0, 4096), { format });
      const { signal } = new AbortController();
      const compressed = await next.compress(text, { format, dictionary, signal });
      expect(compressed).toEqual(next.compressSync(text, { format, dictionary }));
      expect(compressed).not.toEqual(next.compressSync(text, { format }));
      expect(await next.decompress(compressed, { format, dictionary, signal })).toEqual(text);
    },
  );

  it('rejects an aborted call whose Dictionary was closed before it settled', async () => {
    const bytes = text.subarray(0, 4096);
    const expected = next.compressSync(text, {
      format: 'zstd',
      dictionary: next.Dictionary.from(bytes, { format: 'zstd' }),
    });
    const aborted = new AbortController();
    const reason = new Error('aborted');
    const dictionary = next.Dictionary.from(bytes, { format: 'zstd' });
    const withdrawn = next.compress(text, { format: 'zstd', dictionary, signal: aborted.signal });
    aborted.abort(reason);
    dictionary.close();
    expect(await rejection(withdrawn)).toBe(reason);

    // A call keeps the Dictionary it started with, closed or not.
    const kept = next.Dictionary.from(bytes, { format: 'zstd' });
    const promise = next.compress(text, {
      format: 'zstd',
      dictionary: kept,
      signal: new AbortController().signal,
    });
    kept.close();
    expect(await promise).toEqual(expected);
  });

  it('leaves the onabort handler of the caller in place', async () => {
    const controller = new AbortController();
    const onabort = vi.fn();
    controller.signal.onabort = onabort;
    const promise = next.compress(text, { format: 'zstd', signal: controller.signal });
    controller.abort();
    expect(await rejection(promise)).toBe(controller.signal.reason);
    expect(controller.signal.onabort).toBe(onabort);
    expect(onabort).toHaveBeenCalledTimes(1);
  });

  it('listens to the signal until the call settles', async () => {
    const { signal } = new AbortController();
    const resolved = next.compress(text, { format: 'zstd', signal });
    expect(getEventListeners(signal, 'abort')).toHaveLength(1);
    await resolved;
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);

    const rejected = next.compress(text, { format: 'zstd', level: 23, signal });
    expect(getEventListeners(signal, 'abort')).toHaveLength(1);
    await expect(rejected).rejects.toMatchObject({ code: 'ERR_COMPRS_INVALID_ARG' });
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('leaks no listeners over 1,000 calls that share a signal', async () => {
    const { signal } = new AbortController();
    for (let i = 0; i < 1000; i++) {
      const decompressed = next.decompress(zstdText, { format: 'zstd', signal });
      expect(getEventListeners(signal, 'abort')).toHaveLength(1);
      expect(await decompressed).toEqual(text);
    }
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('takes an object that only looks like an AbortSignal', async () => {
    // A signal of a polyfill, or of another realm, has the members that the
    // functions use: `aborted`, `reason` and the two listener methods.
    const target = new EventTarget();
    const signal: LookAlikeSignal = {
      aborted: false,
      reason: undefined,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    };
    expect(await call(next.compress, text, { format: 'zstd', signal })).toEqual(zstdText);

    const promise = call(next.compress, text, { format: 'zstd', signal });
    const reason = new Error('aborted by a polyfill');
    signal.aborted = true;
    signal.reason = reason;
    target.dispatchEvent(new Event('abort'));
    expect(await rejection(promise)).toBe(reason);
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['a plain object', {}],
    ['an AbortController', new AbortController()],
    [
      'an object with a string as aborted',
      { aborted: 'no', addEventListener() {}, removeEventListener() {} },
    ],
  ])('rejects %s with ERR_COMPRS_INVALID_ARG', async (_, signal) => {
    for (const [, abortable] of CALLS) {
      const error = await rejection(abortable(signal));
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({
        code: 'ERR_COMPRS_INVALID_ARG',
        message: 'signal must be an AbortSignal',
      });
    }
  });

  it('reads the signal with the other options, before the data', async () => {
    // A getter of the signal that detaches the buffer of the data makes the
    // call fail with a code rather than compress nothing.
    const data = Uint8Array.from(text);
    const options = {
      format: 'zstd',
      get signal(): undefined {
        structuredClone(data.buffer, { transfer: [data.buffer] });
        return undefined;
      },
    };
    await expect(call(next.compress, data, options)).rejects.toMatchObject({
      code: 'ERR_COMPRS_INVALID_ARG',
      message: 'data is backed by a detached ArrayBuffer',
    });
  });

  it('is ignored by the *Sync functions', () => {
    // They do not declare it, and do not read it.
    const compressOptions: CompressOptions = { format: 'zstd' };
    expect(next.compressSync(text, unreadSignal(compressOptions))).toEqual(zstdText);
    expect(next.decompressSync(zstdText, unreadSignal({}))).toEqual(text);
    expect(next.trainDictionarySync(samples, unreadSignal({ maxSize: 4096 }))).toEqual(
      next.trainDictionarySync(samples, { maxSize: 4096 }),
    );
  });
});

/** `options`, with a `signal` getter that throws when it is read. */
function unreadSignal<T extends object>(options: T): T {
  return Object.defineProperty(options, 'signal', {
    enumerable: true,
    get(): never {
      throw new Error('read the signal');
    },
  });
}

/** An object that has the members of an AbortSignal that ./next uses. */
interface LookAlikeSignal {
  aborted: boolean;
  reason: unknown;
  addEventListener: EventTarget['addEventListener'];
  removeEventListener: EventTarget['removeEventListener'];
}

describe('aborted work in the thread pool of Node.js', () => {
  // abort-child.cjs runs in a Node.js process of its own, with a thread
  // pool of one thread. PROCESS_TIMEOUT is how long it may run; Vitest fails
  // a test that outlasts its own timeout (5 s by default) even while it
  // waits in execFileSync, so the test gets twice this.
  const PROCESS_TIMEOUT = 60_000;

  it('is withdrawn when it has not started', { timeout: 2 * PROCESS_TIMEOUT }, () => {
    const script = resolve(__dirname, 'fixtures/abort-child.cjs');
    const stdout = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
      timeout: PROCESS_TIMEOUT,
    });
    expect(JSON.parse(stdout)).toEqual({
      order: ['second rejected with the reason', 'first resolved'],
      // The codec would have failed with ERR_COMPRS_CORRUPT_DATA.
      third: { withdrawn: true, code: 'Cancelled' },
    });
  });
});
