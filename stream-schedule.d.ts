/** The methods of a stream context that a ChunkScheduler calls. */
export interface AsyncCapableContext {
    transform(chunk: Uint8Array): Uint8Array;
    transformAsync(chunk: Uint8Array): Promise<Uint8Array>;
    flush(): Uint8Array;
    flushAsync(): Promise<Uint8Array>;
    finish(): Uint8Array;
    finishAsync(): Promise<Uint8Array>;
}
/**
 * A codec and a direction, whose speed msPerBytePrior() estimates. Raw
 * deflate and zlib run at the speed of gzip.
 */
export type CodecOp = 'zstd-compress' | 'zstd-decompress' | 'gzip-compress' | 'gzip-decompress' | 'brotli-compress' | 'brotli-decompress' | 'lz4-compress' | 'lz4-decompress';
/**
 * The time per input byte, in milliseconds, that the stream contexts of
 * `op` take at `level`, the level or quality that their constructor took, as
 * measured on one machine: a prior estimate for a ChunkScheduler, which
 * learns the speed on the machine it runs on as the stream goes.
 */
export declare function msPerBytePrior(op: CodecOp, level: number | undefined): number;
/**
 * Input, in bytes, that the encoder of `op` at `level` collects into a block
 * before it compresses any of it, as measured: zstd compresses blocks of
 * 128 KiB, and brotli blocks of 16 KiB at qualities 2 and 3, 64 KiB at 4 to
 * 8 and 256 KiB from 9 on. The transform() whose input completes a block
 * compresses all of the block, however small its own chunk: 256 KiB at
 * brotli quality 9 take about 70 ms. 0 for the other codecs, which compress
 * their input as it comes or in blocks that take well under 2 ms.
 */
export declare function blockBytes(op: CodecOp, level: number | undefined): number;
/**
 * Time, in milliseconds, that the first transform() of a
 * ZstdCompressContext at `level` takes to set up its encoder, as measured
 * on one machine (see ZSTD_SETUP_MS).
 */
export declare function zstdSetupMs(level: number | undefined): number;
/**
 * Input, in bytes, that a BrotliCompressDictContext with `{ incremental:
 * true }` holds before it compresses any: brotli_stream::DICT_REACH in
 * crates/core-lib/src/brotli_stream.rs. The transform() whose input passes
 * it compresses all the input so far.
 */
export declare const BROTLI_DICT_REACH: number;
/** What a ChunkScheduler knows of how its context processes its input. */
export interface ContextModel {
    /**
     * Input, in bytes, that the codec collects into a block before it
     * processes any of it, such as blockBytes() returns. The transform()
     * whose input completes a block processes all of the block. Blocks start
     * with the stream, after flush(), and after the input that the context
     * holds.
     */
    readonly block?: number;
    /**
     * Input, in bytes, that the context holds before it processes any. It
     * processes all of it in the transform() whose input passes that, as an
     * incremental BrotliCompressDictContext does past BROTLI_DICT_REACH.
     */
    readonly holds?: number;
    /**
     * Time, in milliseconds, that the first transform() takes to set up the
     * codec, such as zstdSetupMs() returns.
     */
    readonly setupMs?: number;
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
export declare class ChunkScheduler {
    #private;
    /**
     * @param ctx The context to call.
     * @param msPerByte A prior estimate of the time per input byte of `ctx`,
     *   in milliseconds, such as msPerBytePrior() returns.
     * @param model How `ctx` processes its input. Without it, the scheduler
     *   takes `ctx` to process each chunk as it comes.
     */
    constructor(ctx: AsyncCapableContext, msPerByte: number, model?: ContextModel);
    /** Call transform(chunk) or transformAsync(chunk). */
    transform(chunk: Uint8Array): Uint8Array | Promise<Uint8Array>;
    /** Call flush() or flushAsync(). */
    flush(): Uint8Array | Promise<Uint8Array>;
    /** Call finish() or finishAsync(). */
    finish(): Uint8Array | Promise<Uint8Array>;
}
/**
 * A ChunkScheduler for `ctx`, a stream context of `op` at `level`, from the
 * measured speed and blocks of the codec (see msPerBytePrior() and
 * blockBytes()) and what `model` adds.
 */
export declare function codecScheduler(ctx: AsyncCapableContext, op: CodecOp, level: number | undefined, model?: ContextModel): ChunkScheduler;
/**
 * Pass `result`, which a ChunkScheduler returned, to `use`: now, if it is
 * the output, or once it resolves, if it is a Promise. Return what `use`
 * returned, or a Promise of it.
 */
export declare function afterOutput(result: Uint8Array | Promise<Uint8Array>, use: (output: Uint8Array) => Promise<void> | undefined): Promise<void> | undefined;
