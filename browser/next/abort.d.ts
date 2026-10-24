import type { AbortSignalLike } from './api.js';
import { type Withdrawal } from './backend.js';
/**
 * Whether `value` has the members of an AbortSignal that
 * {@link withSignal} uses: a boolean `aborted`, and the methods
 * `addEventListener()` and `removeEventListener()`. That takes the signals
 * of every realm, and those of polyfills, which may lack the other members,
 * such as `throwIfAborted()`.
 */
export declare function isAbortSignal(value: unknown): value is AbortSignalLike;
/**
 * The Promise of `start()`, which starts the work of a call with the
 * {@link Withdrawal} that it gets, settled as `signal` tells, as fetch()
 * settles:
 *
 * - without a signal, the Promise of `start()` itself, which gets no
 *   Withdrawal;
 * - with a signal that is already aborted, a Promise that rejects with its
 *   `reason`, without calling `start()`;
 * - otherwise, a Promise that rejects with the reason of `signal` if it
 *   aborts before the work settles: at once if the backend withdraws the
 *   work, which no thread had started, or else once the work settles,
 *   discarding what it gave. The Promise keeps the result of work that
 *   settled before the abort.
 */
export declare function withSignal<T>(signal: AbortSignalLike | undefined, start: (withdrawal: Withdrawal | undefined) => Promise<T>): Promise<T>;
