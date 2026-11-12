import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettleWatcher, SETTLE_CAP_MS, SETTLE_QUIET_MS, SETTLED_MARK, IDLE_FALLBACK_MS, type SettleDeps } from './settle.ts';

/** A fake page: a manual clock and timer queue, a resource counter, the LCP marker, and an optional requestIdleCallback. */
function fakePage(opts: { idle?: boolean; loaded?: boolean } = {}) {
	let now = 0;
	let timers: Array<{ at: number; fn: () => void }> = [];
	const idles: Array<{ fn: () => void; timeout: number }> = [];
	const marks: string[] = [];
	const loadListeners: Array<() => void> = [];
	const page = { resources: 0, lcpPending: false, loaded: opts.loaded ?? true };
	const deps: SettleDeps = {
		now: () => now,
		setTimeout: (fn, ms) => {
			timers.push({ at: now + ms, fn });
		},
		requestIdleCallback: null,
		lcpPending: () => page.lcpPending,
		resourceCount: () => page.resources,
		mark: (name) => {
			marks.push(name);
		},
		afterLoad: (fn) => {
			if (page.loaded) {
				fn();
			} else {
				loadListeners.push(fn);
			}
		},
	};
	if (opts.idle !== false) {
		deps.requestIdleCallback = (fn, options) => {
			idles.push({ fn, timeout: options.timeout });
		};
	}
	/** Advance the clock to `to`, running every timer due on the way, in order. */
	const advance = (to: number): void => {
		for (;;) {
			const due = timers.filter((t) => t.at <= to).sort((a, b) => a.at - b.at)[0];
			if (!due) {
				break;
			}
			timers = timers.filter((t) => t !== due);
			now = due.at;
			due.fn();
		}
		now = to;
	};
	/** Run every requested idle callback. */
	const runIdle = (): void => {
		for (const idle of idles.splice(0)) {
			idle.fn();
		}
	};
	const fireLoad = (): void => {
		page.loaded = true;
		for (const fn of loadListeners.splice(0)) {
			fn();
		}
	};
	return { deps, page, marks, idles, advance, runIdle, fireLoad };
}

test('the work runs on idle once no resource finished for the quiet window', () => {
	const p = fakePage();
	let ran = 0;
	new SettleWatcher(p.deps).run(() => { ran++; });
	p.advance(SETTLE_QUIET_MS - 1);
	assert.equal(p.idles.length, 0, 'not settled yet');
	p.advance(SETTLE_QUIET_MS);
	assert.equal(p.idles.length, 1, 'settled: the idle step is requested');
	assert.equal(p.idles[0].timeout, 3000, 'with the default idle timeout');
	assert.equal(ran, 0, 'the work waits for idle');
	p.runIdle();
	assert.equal(ran, 1);
});

test('a resource that finishes restarts the quiet window', () => {
	const p = fakePage();
	new SettleWatcher(p.deps).run(() => {});
	p.advance(1200);
	p.page.resources = 3; // a resource finished at 1200, seen on the next look (every SETTLE_TICK_MS: at 1500)
	p.advance(1500 + SETTLE_QUIET_MS - 1);
	assert.equal(p.idles.length, 0, 'still inside the window that restarted at 1500');
	p.advance(1500 + SETTLE_QUIET_MS);
	assert.equal(p.idles.length, 1);
});

test('the work waits while an element marks a pending LCP resource', () => {
	const p = fakePage();
	p.page.lcpPending = true;
	new SettleWatcher(p.deps).run(() => {});
	p.advance(10_000);
	assert.equal(p.idles.length, 0, 'held by data-rr-lcp-pending');
	p.page.lcpPending = false;
	p.advance(10_500);
	assert.equal(p.idles.length, 1, 'released on the next look once the marker is gone');
});

test('the cap starts the work regardless of a stalled resource or marker', () => {
	const p = fakePage();
	p.page.lcpPending = true;
	new SettleWatcher(p.deps).run(() => {});
	p.advance(SETTLE_CAP_MS - 1);
	assert.equal(p.idles.length, 0);
	p.advance(SETTLE_CAP_MS);
	assert.equal(p.idles.length, 1, 'capped at SETTLE_CAP_MS');
});

test('the wait starts at load, not before', () => {
	const p = fakePage({ loaded: false });
	new SettleWatcher(p.deps).run(() => {});
	p.advance(SETTLE_CAP_MS - 1000);
	assert.equal(p.idles.length, 0, 'nothing before load');
	p.fireLoad();
	p.advance(SETTLE_CAP_MS - 1000 + SETTLE_QUIET_MS);
	assert.equal(p.idles.length, 1, 'settled after load');
	p.advance(SETTLE_CAP_MS * 3);
	assert.equal(p.idles.length, 1, 'the bound on a missing load does not run the work again');
});

test('a load that never fires does not hold the work: it starts SETTLE_CAP_MS after run, once', () => {
	const p = fakePage({ loaded: false });
	let ran = 0;
	new SettleWatcher(p.deps).run(() => { ran++; });
	p.advance(SETTLE_CAP_MS - 1);
	assert.equal(p.idles.length, 0);
	p.advance(SETTLE_CAP_MS);
	assert.equal(p.idles.length, 1, 'the stalled load is bounded');
	p.runIdle();
	assert.equal(ran, 1);
	p.fireLoad(); // the stalled resource finally loads
	p.advance(SETTLE_CAP_MS * 3);
	assert.equal(p.idles.length, 0, 'the post-load settle does not run the work a second time');
});

test('a load that fires shortly before the bound keeps its full settle wait', () => {
	const p = fakePage({ loaded: false });
	p.page.lcpPending = true;
	new SettleWatcher(p.deps).run(() => {});
	p.advance(SETTLE_CAP_MS - 10);
	p.fireLoad();
	p.advance(SETTLE_CAP_MS + 5_000);
	assert.equal(p.idles.length, 0, 'the run-time bound applies only while load has not fired');
	p.advance(SETTLE_CAP_MS - 10 + SETTLE_CAP_MS);
	assert.equal(p.idles.length, 1, "the settle wait's own cap after load");
});

test('without requestIdleCallback the idle step is a fixed delay', () => {
	const p = fakePage({ idle: false });
	let ran = 0;
	new SettleWatcher(p.deps).run(() => { ran++; });
	p.advance(SETTLE_QUIET_MS + IDLE_FALLBACK_MS - 1);
	assert.equal(ran, 0);
	p.advance(SETTLE_QUIET_MS + IDLE_FALLBACK_MS);
	assert.equal(ran, 1);
});

test('the settled mark is left once, by the first work that runs', () => {
	const p = fakePage();
	const watcher = new SettleWatcher(p.deps);
	const order: string[] = [];
	watcher.run(() => { order.push(`first after ${p.marks.length} mark`); });
	watcher.run(() => { order.push('second'); });
	p.advance(SETTLE_QUIET_MS);
	p.runIdle();
	assert.deepEqual(p.marks, [SETTLED_MARK]);
	assert.deepEqual(order, ['first after 1 mark', 'second'], 'the mark is left before the first work runs');
});
