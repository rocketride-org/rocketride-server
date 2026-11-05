/**
 * Wall-clock budgets in tests: the best of N timed samples after a warm-up.
 *
 * One sample on a busy CI runner (module tests run side by side) measures the
 * neighbours as much as the code. The best of a few samples is the code's own
 * cost plus the least noise, so the bound stays exactly as written.
 */

/** How many timed samples a budget takes the best of. */
export const SAMPLES = 3;

/**
 * Run `fn` once to warm up, then `samples` times under the clock.
 * Returns the fastest time in milliseconds and the last result.
 */
export function bestOf<T>(fn: () => T, samples: number = SAMPLES): { ms: number; out: T } {
	let out = fn();
	let ms = Infinity;
	for (let run = 0; run < samples; run += 1) {
		const started = performance.now();
		out = fn();
		ms = Math.min(ms, performance.now() - started);
	}
	return { ms, out };
}
