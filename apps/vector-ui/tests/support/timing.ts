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

/**
 * A wall-clock budget, in milliseconds, for the machine the tests run on.
 *
 * On a shared CI runner the builder runs every module's tests side by side on
 * a few cores, and the same work there measures 11-15 times slower than on a
 * developer machine (pure-JS loops and React renders alike), so even the best
 * of several warmed samples measures the neighbours. CI (where `CI` is set)
 * gets six times the budget; a local run keeps the budget exactly as written.
 * The size and count assertions beside each budget still pin the bounded
 * work, so a regression that renders every row fails everywhere.
 */
export function ciBudget(ms: number): number {
	return process.env.CI ? ms * 6 : ms;
}
