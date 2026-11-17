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
 * A render budget, in milliseconds, for the machine the tests run on.
 *
 * Server-rendering a large tree is CPU-bound, and on a shared CI runner the
 * builder runs every module's tests side by side on a few cores: the best of
 * a few warmed samples still measures the neighbours. CI (where `CI` is set)
 * gets five times the budget; a local run keeps the budget exactly as written.
 * The element-count assertions beside each budget are what pin the bounded
 * DOM, so a regression that renders every row still fails everywhere.
 */
export function renderBudget(ms: number): number {
	return process.env.CI ? ms * 5 : ms;
}
