// How the tests of the streams tell that the event loop keeps turning while
// a stream compresses or decompresses (#554, #344): a 1 ms interval timer
// counts how often the event loop gets to it.

/** What the timer saw: its ticks, and the gaps between them, in milliseconds. */
export interface TimerTicks {
  ticks: number;
  median: number;
  longest: number;
}

/**
 * Run `run` while a 1 ms interval timer counts how often the event loop
 * gets to it: the number of ticks, and the median and the longest gap
 * between them, in milliseconds.
 */
export async function timerTicks(run: () => Promise<void>): Promise<TimerTicks> {
  const gaps: number[] = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, 1);
  try {
    await run();
  } finally {
    clearInterval(timer);
  }
  const ticks = gaps.length;
  gaps.push(performance.now() - last);
  gaps.sort((a, b) => a - b);
  return { ticks, median: gaps[gaps.length >> 1] ?? 0, longest: gaps.at(-1) ?? 0 };
}

/** The median gap of the timer on an idle event loop, over 100 ms. */
async function idleMedian(): Promise<number> {
  const idle = await timerTicks(() => new Promise((done) => setTimeout(done, 100)));
  return idle.median;
}

/**
 * The default resolution of the system timer of Windows, in milliseconds,
 * which timers fall back to whenever no program asks for a finer one.
 */
const WINDOWS_TIMER_MS = 15.625;

/**
 * Run `run` with {@link timerTicks}, and return what the timer saw with
 * `bound`, the largest median gap that a test accepts: 10 ms, or twice the
 * resolution of the timers where they are coarser than that.
 *
 * That resolution is measured as the median gap of the timer on an idle
 * event loop, before `run` and after it, and the coarser of the two counts.
 * On Windows, it is at least the default resolution of the system timer,
 * as programs raise and restore the resolution while a test runs: one run
 * saw ticks 14.1 ms apart, and the idle event loop 1 ms ticks both before
 * and after it.
 */
export async function eventLoopTicks(
  run: () => Promise<void>,
): Promise<TimerTicks & { bound: number }> {
  const before = await idleMedian();
  const result = await timerTicks(run);
  const after = await idleMedian();
  const floor = process.platform === 'win32' ? WINDOWS_TIMER_MS : 0;
  return { ...result, bound: Math.max(10, 2 * floor, 2 * before, 2 * after) };
}

/**
 * What the timer saw, for the annotation of a test: the longest gap is only
 * reported, as shared CI runners stall now and then.
 */
export function describeTicks(result: TimerTicks & { bound: number }): string {
  const ms = (gap: number): string => `${gap.toFixed(1)} ms`;
  return `${result.ticks} ticks, median gap ${ms(result.median)} (bound ${ms(result.bound)}), longest gap ${ms(result.longest)}`;
}
