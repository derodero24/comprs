"use strict";
exports.ChunkScheduler = exports.BROTLI_DICT_REACH = void 0;
exports.msPerBytePrior = msPerBytePrior;
exports.blockBytes = blockBytes;
exports.zstdSetupMs = zstdSetupMs;
exports.codecScheduler = codecScheduler;
exports.afterOutput = afterOutput;
const node_timers_1 = require("node:timers");
// The time per input byte, in nanoseconds, of each stream context, called
// synchronously in 64 KiB chunks: the median of three runs of the release
// build of the native addon on Node.js 22.22.0, on x86-64 Linux with 4
// vCPUs, on 4 MiB of text made of random words from a vocabulary of 4,096
// (1 MiB for brotli quality 10 and 11), which compresses about 3:1.
// Decompression was measured on that text compressed at the default level,
// per byte of compressed input. The compression tables hold the levels from
// the lowest one on.
/** zstd compression, levels 1 to 22. */
const ZSTD_COMPRESS = [
    5.2, 6.1, 8.5, 9.9, 14, 21, 28, 34, 38, 57, 90, 110, 430, 590, 640, 640, 740, 850, 820, 880, 820,
    1040,
];
/** gzip, zlib and raw deflate compression, levels 0 to 9. */
const GZIP_COMPRESS = [0.45, 6.1, 9.3, 12, 13, 15, 18, 54, 144, 64];
/** brotli compression, qualities 0 to 11. */
const BROTLI_COMPRESS = [7.4, 11, 14, 17, 41, 70, 93, 150, 200, 260, 1050, 1880];
/** The quality of brotli compression without one. */
const DEFAULT_QUALITY = 6;
/** The other codecs, which have no level. */
const OTHER_NS_PER_BYTE = {
    'zstd-decompress': 6.8,
    'gzip-decompress': 6.9,
    'brotli-decompress': 11,
    'lz4-compress': 3.8,
    'lz4-decompress': 1.4,
};
/**
 * The entry of `table`, which holds the levels from `first` on, for `level`,
 * or for `fallback`, the default level, without a number. Levels outside the
 * table take its nearest entry. The stream contexts have checked the level
 * before a scheduler is made, so this only has to be safe.
 */
function nsPerByte(table, level, first, fallback) {
    const wanted = typeof level === 'number' && !Number.isNaN(level) ? Math.trunc(level) : fallback;
    const index = Math.min(Math.max(wanted - first, 0), table.length - 1);
    return table[index] ?? 0;
}
/**
 * The time per input byte, in milliseconds, that the stream contexts of
 * `op` take at `level`, the level or quality that their constructor took, as
 * measured on one machine: a prior estimate for a ChunkScheduler, which
 * learns the speed on the machine it runs on as the stream goes.
 */
function msPerBytePrior(op, level) {
    let ns;
    switch (op) {
        case 'zstd-compress':
            // Level 0 selects the default level, 3. Negative levels, zstd's fast
            // mode, are faster than level 1, whose entry they take.
            ns = nsPerByte(ZSTD_COMPRESS, level === 0 ? undefined : level, 1, 3);
            break;
        case 'gzip-compress':
            ns = nsPerByte(GZIP_COMPRESS, level, 0, 6);
            break;
        case 'brotli-compress':
            ns = nsPerByte(BROTLI_COMPRESS, level, 0, DEFAULT_QUALITY);
            break;
        default:
            ns = OTHER_NS_PER_BYTE[op];
    }
    return ns / 1e6;
}
/**
 * Input, in bytes, that the encoder of `op` at `level` collects into a block
 * before it compresses any of it, as measured: zstd compresses blocks of
 * 128 KiB, and brotli blocks of 16 KiB at qualities 2 and 3, 64 KiB at 4 to
 * 8 and 256 KiB from 9 on. The transform() whose input completes a block
 * compresses all of the block, however small its own chunk: 256 KiB at
 * brotli quality 9 take about 70 ms. 0 for the other codecs, which compress
 * their input as it comes or in blocks that take well under 2 ms.
 */
function blockBytes(op, level) {
    switch (op) {
        case 'zstd-compress':
            return 128 * 1024;
        case 'brotli-compress': {
            const quality = typeof level === 'number' && !Number.isNaN(level) ? Math.trunc(level) : DEFAULT_QUALITY;
            if (quality < 2)
                return 0;
            if (quality < 4)
                return 16 * 1024;
            return quality < 9 ? 64 * 1024 : 256 * 1024;
        }
        default:
            return 0;
    }
}
/**
 * Time, in milliseconds, that the first transform() of a
 * ZstdCompressContext takes to set up the tables of its encoder, at levels
 * 10 to 22, before it compresses any input: the median of seven runs,
 * measured as the time per byte was. Lower levels take under 1.5 ms. A
 * ZstdCompressDictContext sets up its tables when it is created.
 */
const ZSTD_SETUP_MS = [2.8, 2.4, 37, 29, 34, 34, 17, 25, 27, 48, 89, 176, 412];
/**
 * Time, in milliseconds, that the first transform() of a
 * ZstdCompressContext at `level` takes to set up its encoder, as measured
 * on one machine (see ZSTD_SETUP_MS).
 */
function zstdSetupMs(level) {
    if (typeof level !== 'number' || Number.isNaN(level) || level < 10)
        return 0;
    return ZSTD_SETUP_MS[Math.min(Math.trunc(level), 22) - 10] ?? 0;
}
/**
 * Input, in bytes, that a BrotliCompressDictContext with `{ incremental:
 * true }` holds before it compresses any: brotli_stream::DICT_REACH in
 * crates/core-lib/src/brotli_stream.rs. The transform() whose input passes
 * it compresses all the input so far.
 */
exports.BROTLI_DICT_REACH = 4 * 1024 * 1024 - 16;
/**
 * Predicted time, in milliseconds, from which a call goes to the thread pool.
 * A round trip to the pool took 0.03 ms for LZ4 and up to 0.5 ms for gzip
 * and brotli, whose state then moves between cores: at 1 ms, gzip at level
 * 6 lost a quarter of its throughput on 64 KiB chunks, which take 1.2 ms.
 */
const ASYNC_MS = 2;
/**
 * Time of synchronous calls, in milliseconds, after which the schedulers
 * wait for the event loop to turn.
 */
const YIELD_MS = 4;
/**
 * Smallest input, in bytes, whose time a scheduler learns from: the time of
 * a smaller one is mostly the cost of the call.
 */
const SAMPLE_BYTES = 4096;
/** Weight of the latest time in the moving average of a scheduler. */
const SAMPLE_WEIGHT = 0.25;
// The schedulers of a thread share one budget of synchronous work between
// two turns of its event loop, so that many streams together hold the event
// loop no longer than one does. Once the budget is spent, each call waits
// for a turn of its own: one call goes on per turn, in the order in which
// they started to wait, which they take turns at the event loop with.
/** Time of the synchronous calls since the event loop last turned, in ms. */
let spent = 0;
/** The calls that wait for a turn, oldest first. */
const waiting = [];
/** Whether nextTurn() is scheduled. */
let turnScheduled = false;
/** Make nextTurn() run once the event loop turns, unless it is scheduled. */
function scheduleTurn() {
    if (turnScheduled)
        return;
    turnScheduled = true;
    (0, node_timers_1.setImmediate)(nextTurn);
}
/**
 * Start a new budget, as the event loop has turned, and let the call that
 * has waited longest go on.
 */
function nextTurn() {
    turnScheduled = false;
    spent = 0;
    waiting.shift()?.();
    if (waiting.length > 0)
        scheduleTurn();
}
/** Add `elapsed`, the time of a synchronous call in ms, to the budget. */
function addSpent(elapsed) {
    spent += elapsed;
    scheduleTurn();
}
/** A Promise that resolves once a call may go on, after the event loop has turned. */
function waitForTurn() {
    return new Promise((resolve) => {
        waiting.push(resolve);
        scheduleTurn();
    });
}
/**
 * Calls a stream context, synchronously or on the thread pool, as the
 * predicted time of each call decides.
 *
 * The time of a call is the input that it processes, in bytes, times the
 * time per byte: the larger of the prior estimate that the constructor takes
 * and a moving average of the time per byte of the calls on at least 4 KiB
 * of input. A call predicted to take 2 ms or more runs on the thread pool;
 * its time, until its Promise settles, also includes the round trip to the
 * pool, so a stream that a slow call sent to the pool comes back once its
 * calls there show that they are cheap. A cheaper call runs synchronously.
 * Once the synchronous calls of all the schedulers of the thread have taken
 * 4 ms since the event loop last turned, every call returns a Promise and
 * waits for a turn of the event loop, which lets it run timers and I/O.
 * flush() and finish() go to the pool once any call has, or if the input
 * since the last flush() predicts 2 ms or more.
 *
 * A call usually processes its chunk. Given the blocks of the codec, the
 * scheduler predicts a call whose input completes a block from all of the
 * block, so that a stream of chunks much smaller than a block still sends
 * the work of each block to the pool. Given what a context holds, as an
 * incremental BrotliCompressDictContext holds the start of its input, the
 * scheduler predicts the call whose input passes it from all of the input
 * so far, and the calls before it as free. The first call also takes the
 * time that the codec takes to set itself up, if any.
 *
 * Each method returns the output of the context, or a Promise of it. At most
 * one call may be in flight: the caller waits for a Promise to settle before
 * it calls again, as streams do.
 */
class ChunkScheduler {
    #ctx;
    #prior;
    /** The moving average of the time per byte, or 0 before any sample. */
    #measured = 0;
    /** Whether a call went to the thread pool. */
    #wentAsync = false;
    /** Bytes transformed since the last flush(). */
    #unflushed = 0;
    /** Input, in bytes, that the codec collects into a block, or 0. */
    #block;
    /** Bytes transformed since the blocks of the codec started. */
    #blocked = 0;
    /** Input, in bytes, that the context holds at most before it processes any. */
    #holds;
    /** Input that the context holds, in bytes, or -1 once it processes its input. */
    #held;
    /** Time that the next transform() takes to set up the codec, in ms. */
    #setupMs;
    /**
     * @param ctx The context to call.
     * @param msPerByte A prior estimate of the time per input byte of `ctx`,
     *   in milliseconds, such as msPerBytePrior() returns.
     * @param model How `ctx` processes its input. Without it, the scheduler
     *   takes `ctx` to process each chunk as it comes.
     */
    constructor(ctx, msPerByte, model = {}) {
        const { block = 0, holds = 0, setupMs = 0 } = model;
        this.#ctx = ctx;
        this.#prior = msPerByte;
        this.#block = block;
        this.#holds = holds;
        this.#held = holds > 0 ? 0 : -1;
        this.#setupMs = setupMs;
    }
    /** Call transform(chunk) or transformAsync(chunk). */
    transform(chunk) {
        if (spent >= YIELD_MS)
            return waitForTurn().then(() => this.transform(chunk));
        this.#unflushed += chunk.byteLength;
        const work = this.#work(chunk.byteLength);
        const setupMs = this.#setupMs;
        this.#setupMs = 0;
        const start = performance.now();
        if (setupMs + this.#predict(work) >= ASYNC_MS) {
            this.#wentAsync = true;
            return this.#ctx.transformAsync(chunk).then((output) => {
                this.#learn(work, performance.now() - start - setupMs);
                return output;
            });
        }
        const output = this.#ctx.transform(chunk);
        const elapsed = performance.now() - start;
        this.#learn(work, elapsed - setupMs);
        addSpent(elapsed);
        return output;
    }
    /** Call flush() or flushAsync(). */
    flush() {
        if (spent >= YIELD_MS)
            return waitForTurn().then(() => this.flush());
        if (this.#endsAsync())
            return this.#ctx.flushAsync();
        const start = performance.now();
        const output = this.#ctx.flush();
        addSpent(performance.now() - start);
        return output;
    }
    /** Call finish() or finishAsync(). */
    finish() {
        if (spent >= YIELD_MS)
            return waitForTurn().then(() => this.finish());
        if (this.#endsAsync())
            return this.#ctx.finishAsync();
        const start = performance.now();
        const output = this.#ctx.finish();
        addSpent(performance.now() - start);
        return output;
    }
    /**
     * The input, in bytes, that a transform() of `bytes` bytes processes:
     * none while the context holds its input, all of the input so far in the
     * call that passes what it holds, and from then on the chunk, or the
     * blocks that it completes if they are larger.
     */
    #work(bytes) {
        if (this.#held >= 0) {
            const held = this.#held + bytes;
            if (held <= this.#holds) {
                this.#held = held;
                return 0;
            }
            // The context processes what it holds as a whole, and its blocks
            // start after it.
            this.#held = -1;
            this.#blocked = held - this.#holds;
            return held;
        }
        const before = this.#blocked;
        this.#blocked += bytes;
        if (this.#block === 0)
            return bytes;
        const completed = Math.floor(this.#blocked / this.#block) - Math.floor(before / this.#block);
        return Math.max(bytes, completed * this.#block);
    }
    /** The predicted time of a call on `bytes` bytes of input, in milliseconds. */
    #predict(bytes) {
        return bytes * Math.max(this.#prior, this.#measured);
    }
    /** Add the time of a call that processed `work` bytes to the moving average. */
    #learn(work, elapsed) {
        if (work < SAMPLE_BYTES)
            return;
        const sample = Math.max(elapsed, 0) / work;
        this.#measured =
            this.#measured === 0 ? sample : this.#measured + SAMPLE_WEIGHT * (sample - this.#measured);
    }
    /**
     * Whether flush() or finish() goes to the thread pool, which also starts
     * a new count of the input since the last flush().
     */
    #endsAsync() {
        const unflushed = this.#unflushed;
        this.#unflushed = 0;
        // flush() processes the block in progress, so the next one starts
        // after it. finish() ends the stream.
        this.#blocked = 0;
        this.#wentAsync ||= this.#predict(unflushed) >= ASYNC_MS;
        return this.#wentAsync;
    }
}
exports.ChunkScheduler = ChunkScheduler;
/**
 * A ChunkScheduler for `ctx`, a stream context of `op` at `level`, from the
 * measured speed and blocks of the codec (see msPerBytePrior() and
 * blockBytes()) and what `model` adds.
 */
function codecScheduler(ctx, op, level, model = {}) {
    return new ChunkScheduler(ctx, msPerBytePrior(op, level), {
        block: blockBytes(op, level),
        ...model,
    });
}
/**
 * Pass `result`, which a ChunkScheduler returned, to `use`: now, if it is
 * the output, or once it resolves, if it is a Promise. Return what `use`
 * returned, or a Promise of it.
 */
function afterOutput(result, use) {
    // Not instanceof: under Jest, which runs the stream helpers in a vm
    // context, the Buffers and Promises of the native addon come from another
    // realm.
    return ArrayBuffer.isView(result) ? use(result) : result.then(use);
}
