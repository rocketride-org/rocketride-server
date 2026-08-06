// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EVENTS-UI — CAPTURE ENGINE HOOK
// =============================================================================
//
// Owns the whole capture lifecycle: the DAP-event subscription, the in-memory
// ring buffer, the derived metrics, and the monitor start/stop wiring. The
// view is a thin consumer of the snapshot and actions this returns.
//
// Push, not poll: events arrive on the shell 'shell:event' channel. A burst is
// coalesced into at most one grid + metrics update per FLUSH_INTERVAL_MS by a
// TRAILING THROTTLE armed on event arrival — no perpetual interval. After a
// burst the throttle keeps re-arming only while the trailing-second rate is
// still non-zero, so the rate decays to 0 and then the timer stops entirely.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useClient, useShellEvent } from 'shell';
import type { CaptureSnapshot, CapturedEvent, EventRow, MonitorConfig } from '../types';
import { EVENT_TYPE_NAMES, FLUSH_INTERVAL_MS, MAX_EVENTS } from '../types';
import { summarize } from '../format';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Empty snapshot — the initial state and the target of a Clear. */
const EMPTY_SNAPSHOT: CaptureSnapshot = { rows: [], total: 0, inMemory: 0, rate: 0 };

/** Trailing-second window (ms) used to compute the events/sec rate. */
const RATE_WINDOW_MS = 1000;

// =============================================================================
// TYPES
// =============================================================================

/** The capture engine surface a view composes against. */
export interface IUseEventCaptureResult {
	/** Current monitor configuration (token, subscription types, run flag). */
	config: MonitorConfig;
	/** Latest coalesced snapshot (grid rows + metrics). */
	snapshot: CaptureSnapshot;
	/** Whether a shell client is available to subscribe through. */
	connected: boolean;
	/** Toggle monitoring on/off (subscribe / unsubscribe). */
	toggleActive: () => void;
	/** Drop every captured event and reset the metrics. */
	clear: () => void;
	/** Set the monitored token ('*' = all tasks). */
	setToken: (token: string) => void;
	/** Flip one subscription category's membership. */
	toggleType: (type: string) => void;
	/** Select every subscription category. */
	selectAllTypes: () => void;
	/** Clear the subscription category selection. */
	clearTypes: () => void;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Project the capture buffer into grid rows (a fresh array so the LOCAL grid
 * re-applies), deriving each row's one-line summary from its body.
 *
 * @param events - The current capture buffer.
 * @returns The grid rows in capture order (the grid sorts newest-first).
 */
function buildRows(events: CapturedEvent[]): EventRow[] {
	return events.map((event) => ({
		id: event.id,
		time: event.time,
		eventName: event.eventName,
		token: event.token,
		seq: event.seq,
		summary: summarize(event.body),
		body: event.body,
	}));
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Capture-engine hook: subscribes to DAP events while active, buffers them
 * (capped at {@link MAX_EVENTS}), and publishes a coalesced {@link CaptureSnapshot}.
 *
 * @returns The capture snapshot plus the config and action handlers.
 */
export function useEventCapture(): IUseEventCaptureResult {
	const client = useClient();

	// ── Capture buffer + metric accumulators (mutable refs, not React state:
	//    they churn per-event and must not each trigger a render). ────────────
	const eventsRef = useRef<CapturedEvent[]>([]);
	const totalRef = useRef(0);
	const rateWindowRef = useRef<number[]>([]);
	const nextIdRef = useRef(1);
	// True when the buffer changed since the last flush (rebuild rows) — as
	// opposed to a decay-tail flush that only refreshes the rate.
	const dirtyRef = useRef(false);
	// Pending trailing-throttle handle; null when no flush is scheduled.
	const flushHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// ── Published state the view renders from. ───────────────────────────────
	const [config, setConfig] = useState<MonitorConfig>({
		token: '*',
		types: ['SUMMARY', 'TASK', 'FLOW'],
		active: false,
	});
	const [snapshot, setSnapshot] = useState<CaptureSnapshot>(EMPTY_SNAPSHOT);

	// Ref to the latest scheduleFlush so flush's decay tail avoids a cycle.
	const scheduleFlushRef = useRef<() => void>(() => {});

	/**
	 * Flush the buffer into a new snapshot: prune the rate window, recompute the
	 * events/sec rate, rebuild rows only when the buffer changed, and re-arm the
	 * throttle while the rate is still decaying.
	 */
	const flush = useCallback(() => {
		// Step 1: this run's timer has fired — clear the pending handle.
		flushHandleRef.current = null;
		// Step 2: capture-vs-decay: did the buffer change since the last flush?
		const rowsChanged = dirtyRef.current;
		dirtyRef.current = false;
		// Step 3: prune the trailing-second window and read the current rate.
		const now = Date.now();
		rateWindowRef.current = rateWindowRef.current.filter((t) => now - t < RATE_WINDOW_MS);
		const rate = rateWindowRef.current.length;
		// Step 4: publish — rebuild rows only on a real change; bail out (return
		// the same object, so React skips the render) when nothing is observable.
		setSnapshot((prev) => {
			const rows = rowsChanged ? buildRows(eventsRef.current) : prev.rows;
			const inMemory = eventsRef.current.length;
			if (!rowsChanged && prev.total === totalRef.current && prev.inMemory === inMemory && prev.rate === rate) {
				return prev;
			}
			return { rows, total: totalRef.current, inMemory, rate };
		});
		// Step 5: decay tail — while events remain in the window, keep flushing
		// so the rate ticks down to 0; once it hits 0 no further flush is armed.
		if (rate > 0) scheduleFlushRef.current();
	}, []);

	/**
	 * Arm the trailing throttle: schedule one flush unless a flush is already
	 * pending (so a burst of events coalesces into a single update).
	 */
	const scheduleFlush = useCallback(() => {
		if (flushHandleRef.current !== null) return;
		flushHandleRef.current = setTimeout(flush, FLUSH_INTERVAL_MS);
	}, [flush]);
	scheduleFlushRef.current = scheduleFlush;

	// Handle incoming shell events. useShellEvent stores the handler in a ref and
	// calls the latest version per event, so it always reads the current config.
	useShellEvent('shell:event', ({ event }) => {
		// Only capture while monitoring is active.
		if (!config.active) return;
		// Only DAP events carry a capturable body.
		if (event.type !== 'event') return;
		// Token filter: a concrete token must match; '*' captures every task.
		if (config.token !== '*' && event.token !== config.token) return;

		// Record the event into the ring buffer and the metric accumulators.
		const captured: CapturedEvent = {
			id: nextIdRef.current++,
			time: Date.now(),
			eventName: event.event ?? 'unknown',
			body: (event.body ?? {}) as Record<string, unknown>,
			token: (event.token ?? '') as string,
			seq: event.seq ?? 0,
		};
		eventsRef.current.push(captured);
		totalRef.current++;
		rateWindowRef.current.push(captured.time);

		// Cap memory — trim in batches (at 1.2x) to amortize the slice cost.
		if (eventsRef.current.length > MAX_EVENTS * 1.2) {
			eventsRef.current = eventsRef.current.slice(-MAX_EVENTS);
		}

		// Mark dirty and coalesce this event into the next throttled flush.
		dirtyRef.current = true;
		scheduleFlush();
	});

	// Subscribe on start, unsubscribe on stop; a failed subscribe resets active.
	useEffect(() => {
		if (!client) return;
		if (!config.active) return;

		// The monitor is keyed on the token; the types select the categories.
		const key = { token: config.token };
		client.addMonitor(key, config.types).catch((err) => {
			console.error('[events-ui] addMonitor failed', err);
			setConfig((c) => ({ ...c, active: false }));
		});

		return () => {
			client.removeMonitor(key, config.types).catch((err) => {
				console.error('[events-ui] removeMonitor failed', err);
			});
		};
	}, [client, config.active, config.token, config.types]);

	// Cancel any pending flush on unmount (no timer outlives the component).
	useEffect(() => {
		return () => {
			if (flushHandleRef.current !== null) {
				clearTimeout(flushHandleRef.current);
				flushHandleRef.current = null;
			}
		};
	}, []);

	// ── Actions ──────────────────────────────────────────────────────────────

	/** Toggle monitoring on/off. */
	const toggleActive = useCallback(() => {
		setConfig((c) => ({ ...c, active: !c.active }));
	}, []);

	/** Drop every captured event and reset the metrics to empty immediately. */
	const clear = useCallback(() => {
		eventsRef.current = [];
		totalRef.current = 0;
		rateWindowRef.current = [];
		nextIdRef.current = 1;
		dirtyRef.current = false;
		setSnapshot(EMPTY_SNAPSHOT);
	}, []);

	/** Set the monitored token. */
	const setToken = useCallback((token: string) => {
		setConfig((c) => ({ ...c, token }));
	}, []);

	/** Flip one subscription category's membership. */
	const toggleType = useCallback((type: string) => {
		setConfig((c) => {
			const types = c.types.includes(type) ? c.types.filter((t) => t !== type) : [...c.types, type];
			return { ...c, types };
		});
	}, []);

	/** Select every subscription category. */
	const selectAllTypes = useCallback(() => {
		setConfig((c) => ({ ...c, types: [...EVENT_TYPE_NAMES] }));
	}, []);

	/** Clear the subscription category selection. */
	const clearTypes = useCallback(() => {
		setConfig((c) => ({ ...c, types: [] }));
	}, []);

	return {
		config,
		snapshot,
		connected: Boolean(client),
		toggleActive,
		clear,
		setToken,
		toggleType,
		selectAllTypes,
		clearTypes,
	};
}
