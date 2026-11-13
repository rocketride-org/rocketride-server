// =============================================================================
// Settle: deferred work that waits for the page, not only for the load event.
// The shell's `load` fires long before the home remote mounts, so "idle after
// load" alone would start a deferred chunk the instant the hero image starts
// downloading and share its bandwidth on a slow network. SettleWatcher waits
// until the page has settled, then for idle. It takes its clock, timers and
// page reads as injected deps and is unit-tested under node:test
// (test/unit/settle.test.ts); onIdleAfterLoad runs it on the browser's own.
// =============================================================================

/** No resource finished for this long: the page has settled. */
export const SETTLE_QUIET_MS = 1500;
/** How often the settle wait looks again. */
export const SETTLE_TICK_MS = 500;
/**
 * The settle wait gives up this long after load, so a stalled resource never holds the deferred work; and
 * when `load` itself has not fired this long after run(), the work starts anyway (a stalled image or other
 * load-blocking resource must not hold it forever).
 */
export const SETTLE_CAP_MS = 20_000;
/** Without requestIdleCallback (Safari), the idle step is this delay. */
export const IDLE_FALLBACK_MS = 1500;
/** The first settled idle callback leaves one performance mark: the point the deferred telemetry work starts. */
export const SETTLED_MARK = 'rr:telemetry-settled';

/** What the settle wait reads and schedules with: the browser's own (browserSettleDeps), fakes in tests. */
export type SettleDeps = {
	now(): number;
	setTimeout(fn: () => void, ms: number): void;
	/** The browser's requestIdleCallback, or null where there is none. */
	requestIdleCallback: ((fn: () => void, options: { timeout: number }) => void) | null;
	/** Whether an element still marks a pending LCP resource (`data-rr-lcp-pending`). */
	lcpPending(): boolean;
	/** How many resources have finished loading so far (resource timing entries). */
	resourceCount(): number;
	/** Leave a performance mark. */
	mark(name: string): void;
	/** Run fn once the document has loaded: at once when it already has. */
	afterLoad(fn: () => void): void;
};

/**
 * Runs work once the page has settled: the document loaded, no element marks a
 * pending LCP resource (`data-rr-lcp-pending`, set by a page on its hero image
 * until it has loaded), and no resource finished in the last SETTLE_QUIET_MS;
 * then on idle. The shell's `load` fires long before the home remote mounts, so
 * "idle after load" alone starts every deferred chunk the instant the hero image
 * starts downloading and shares its bandwidth on a slow network. Capped at
 * SETTLE_CAP_MS after load so a stalled resource never holds the deferred work,
 * and at SETTLE_CAP_MS after run() while `load` has not fired at all.
 */
export class SettleWatcher {
	private readonly deps: SettleDeps;
	private marked = false;

	/**
	 * @param deps - The clock, timers and page reads.
	 */
	constructor(deps: SettleDeps) {
		this.deps = deps;
	}

	/**
	 * Run `fn` once the page has settled, then on idle.
	 *
	 * @param fn - The deferred work.
	 * @param timeoutMs - requestIdleCallback's timeout: the idle step runs by then even on a busy page.
	 */
	run(fn: () => void, timeoutMs = 3000): void {
		// Step 1: the work goes to idle once per run, whichever path gets there first.
		let isDone = false;
		let isLoaded = false;
		const finish = (): void => {
			if (isDone) {
				return;
			}
			isDone = true;
			this.idle(fn, timeoutMs);
		};
		// Step 2: the normal path: wait for load, then for the page to settle.
		this.deps.afterLoad(() => {
			isLoaded = true;
			this.settle(finish, () => isDone);
		});
		// Step 3: the bound on a load that never fires; once it fired, the settle wait's own cap governs.
		this.deps.setTimeout(() => {
			if (!isLoaded) {
				finish();
			}
		}, SETTLE_CAP_MS);
	}

	/**
	 * Wait for the page to settle after load (or for the cap), then call `finish`.
	 *
	 * @param finish - Hands the work to the idle step (once).
	 * @param isDone - Whether the work already went to idle: the wait then stops looking.
	 */
	private settle(finish: () => void, isDone: () => boolean): void {
		const started = this.deps.now();
		let lastCount = -1;
		let quietSince = started;
		const tick = (): void => {
			if (isDone()) {
				return;
			}
			const now = this.deps.now();
			const count = this.deps.resourceCount();
			if (count !== lastCount) {
				lastCount = count;
				quietSince = now;
			}
			const settled = !this.deps.lcpPending() && now - quietSince >= SETTLE_QUIET_MS;
			if (settled || now - started >= SETTLE_CAP_MS) {
				finish();
				return;
			}
			this.deps.setTimeout(tick, SETTLE_TICK_MS);
		};
		tick();
	}

	private idle(fn: () => void, timeoutMs: number): void {
		const run = (): void => {
			if (!this.marked) {
				this.marked = true;
				this.deps.mark(SETTLED_MARK);
			}
			fn();
		};
		if (this.deps.requestIdleCallback) {
			this.deps.requestIdleCallback(run, { timeout: timeoutMs });
		} else {
			this.deps.setTimeout(run, IDLE_FALLBACK_MS);
		}
	}
}

/** The browser's clock, timers and page reads for the page's SettleWatcher. */
function browserSettleDeps(): SettleDeps {
	const w = window as Window & { requestIdleCallback?: (fn: () => void, options: { timeout: number }) => number };
	let requestIdle: SettleDeps['requestIdleCallback'] = null;
	if (typeof w.requestIdleCallback === 'function') {
		requestIdle = (fn, options) => {
			w.requestIdleCallback?.(fn, options);
		};
	}
	return {
		now: () => Date.now(),
		setTimeout: (fn, ms) => {
			window.setTimeout(fn, ms);
		},
		requestIdleCallback: requestIdle,
		lcpPending: () => document.querySelector('[data-rr-lcp-pending]') !== null,
		// The browser boundary: a performance call that throws must never hold back or drop the deferred work.
		resourceCount: () => {
			try {
				return performance.getEntriesByType('resource').length;
			} catch {
				return 0; // no resource timing: the marker and the cap decide
			}
		},
		mark: (name) => {
			try {
				performance.mark(name);
			} catch {
				/* no User Timing: nothing to mark */
			}
		},
		afterLoad: (fn) => {
			if (document.readyState === 'complete') {
				fn();
			} else {
				window.addEventListener('load', fn, { once: true });
			}
		},
	};
}

let pageSettle: SettleWatcher | null = null;

/**
 * Run `fn` once the page has settled, then on idle (SettleWatcher, on the browser's own deps).
 *
 * @param fn - The deferred work.
 * @param timeoutMs - requestIdleCallback's timeout.
 */
export function onIdleAfterLoad(fn: () => void, timeoutMs = 3000): void {
	if (!pageSettle) {
		pageSettle = new SettleWatcher(browserSettleDeps());
	}
	pageSettle.run(fn, timeoutMs);
}
