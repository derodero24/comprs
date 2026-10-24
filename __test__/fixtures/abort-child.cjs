// Run by next-abort.spec.ts in a Node.js process of its own, whose libuv
// thread pool has a single thread: the test sets UV_THREADPOOL_SIZE=1, which
// takes effect only before the pool starts. A first compress() of
// @derodero24/comprs/next occupies that thread with 1 MiB of JSON lines at
// zstd level 19, and a second call waits in the queue behind it until its
// signal aborts, at once. Writes, as JSON to stdout, the order in which the
// calls settled, `order`: the second call must reject with the reason of
// the abort before the first resolves, which it can only if its work was
// withdrawn. A third call, of the hidden binding, decompresses corrupt data
// behind them, and is withdrawn too: `third` is what withdraw() returned,
// and the code of the error that the call of the binding rejected with when
// the thread reached it, which shows whether the codec ran.
'use strict';

const { compress } = require('../../next/index.js');

/**
 * The functions of the hidden binding that this script calls.
 *
 * @type {{
 *   createWithdrawal(): object;
 *   withdraw(withdrawal: object): boolean;
 *   decompressAsync(...args: unknown[]): Promise<Uint8Array>;
 * }}
 */
const binding = Reflect.get(require('../../index.js'), Symbol.for('@derodero24/comprs/internal'));

/** 1 MiB of JSON lines. */
function jsonLines() {
  const events = ['open', 'read', 'write', 'close'];
  const lines = [];
  let size = 0;
  for (let id = 0; size < 1 << 20; id++) {
    const user = (id * 7919) % 100_000;
    const line = `${JSON.stringify({ id, user: `user_${user}`, event: events[id % 4], ok: id % 3 !== 0 })}\n`;
    lines.push(line);
    size += line.length;
  }
  return Buffer.from(lines.join('')).subarray(0, 1 << 20);
}

async function main() {
  const data = jsonLines();
  /** @type {string[]} */
  const order = [];
  const first = compress(data, { format: 'zstd', level: 19 }).then(
    () => order.push('first resolved'),
    (error) => order.push(`first rejected: ${error}`),
  );
  const controller = new AbortController();
  const reason = new Error('no longer needed');
  const second = compress(data.subarray(0, 1024), {
    format: 'zstd',
    signal: controller.signal,
  }).then(
    () => order.push('second resolved'),
    (error) =>
      order.push(
        error === reason ? 'second rejected with the reason' : `second rejected: ${error}`,
      ),
  );
  controller.abort(reason);
  const withdrawal = binding.createWithdrawal();
  const corrupt = binding.decompressAsync(
    Buffer.from('not zstd data'),
    'zstd',
    undefined,
    undefined,
    undefined,
    withdrawal,
  );
  const withdrawn = binding.withdraw(withdrawal);
  const third = corrupt.then(
    () => ({ withdrawn, code: 'resolved' }),
    (error) => ({ withdrawn, code: error.code }),
  );
  await Promise.all([first, second]);
  process.stdout.write(JSON.stringify({ order, third: await third }));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
