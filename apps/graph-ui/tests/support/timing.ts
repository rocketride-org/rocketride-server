// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WALL-CLOCK BOUNDS THAT SURVIVE A BUSY MACHINE
// =============================================================================
//
// CI runs module tests in parallel, and a single timed sample of a CPU-bound
// function includes whatever else the machine did at that moment (a Windows
// runner showed it). A bound on the BEST of a few samples, after one warm-up
// run, asks the real question - can this finish within the bound - without
// weakening the bound: a function that is really too slow is slow in every
// sample.
// =============================================================================

/** How many timed samples a bound is checked against. */
export const TIMING_SAMPLES = 3;

/**
 * Time a function: one untimed warm-up run, then the best of `samples` timed runs.
 *
 * @param run - The work (deterministic; it runs `samples + 1` times).
 * @param samples - Timed runs (default {@link TIMING_SAMPLES}).
 * @returns The fastest sample in milliseconds and the last run's result.
 */
export function bestOfMs<T>(run: () => T, samples: number = TIMING_SAMPLES): { ms: number; result: T } {
	let result = run();
	let best = Infinity;
	for (let i = 0; i < samples; i += 1) {
		const started = performance.now();
		result = run();
		best = Math.min(best, performance.now() - started);
	}
	return { ms: best, result };
}
