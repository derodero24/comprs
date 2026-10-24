"use strict";
exports.isAbortSignal = isAbortSignal;
exports.withSignal = withSignal;
const backend_js_1 = require("./backend.js");
// The `signal` option of the async functions of api.ts (#559). The signal
// never reaches the backend: a listener of this module, removed when the
// call settles, withdraws the work of the call through the backend when the
// signal aborts. napi-rs could take a signal and withdraw the work itself,
// but it takes the signal over by assigning its `onabort` property, and
// leaks native memory for each signal that it converts.
/**
 * Whether `value` has the members of an AbortSignal that
 * {@link withSignal} uses: a boolean `aborted`, and the methods
 * `addEventListener()` and `removeEventListener()`. That takes the signals
 * of every realm, and those of polyfills, which may lack the other members,
 * such as `throwIfAborted()`.
 */
function isAbortSignal(value) {
    return (typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'aborted') === 'boolean' &&
        typeof Reflect.get(value, 'addEventListener') === 'function' &&
        typeof Reflect.get(value, 'removeEventListener') === 'function');
}
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
function withSignal(signal, start) {
    // Without a signal, the call costs no more than without the option.
    return signal === undefined ? start(undefined) : settleWith(signal, start);
}
/** {@link withSignal} with a signal. */
async function settleWith(signal, start) {
    if (signal.aborted) {
        throw signal.reason;
    }
    const withdrawal = (0, backend_js_1.backend)().createWithdrawal();
    // The executor of `withdrawn` replaces this at once.
    let onAbort = () => { };
    // Rejects when the backend withdraws the work; never settles otherwise.
    const withdrawn = new Promise((_, reject) => {
        onAbort = () => {
            if (withdrawal !== undefined && (0, backend_js_1.backend)().withdraw(withdrawal)) {
                reject(signal.reason);
            }
        };
    });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        const result = await Promise.race([start(withdrawal), withdrawn]);
        if (signal.aborted) {
            throw signal.reason;
        }
        return result;
    }
    catch (error) {
        if (signal.aborted) {
            throw signal.reason;
        }
        throw error;
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
