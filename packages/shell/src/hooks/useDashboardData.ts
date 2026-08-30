// MIT License
//
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
// USE DASHBOARD DATA — Shared hook for server monitor data
// =============================================================================
//
// Polls the dashboard endpoint every 3 seconds and subscribes to live events.
// Uses module-level state so data persists across view switches without
// re-mounting or re-fetching.
// =============================================================================

import { useEffect, useCallback, useSyncExternalStore } from 'react';
import { useShellConnection } from '../connection/ConnectionContext';
import { ConnectionManager } from '../connection/connection';
import { getClient } from '../util/getClient';
import { parseActivityEvent } from '../modules/server';
import type { DashboardResponse, ActivityEvent } from '../modules/server';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Dashboard polling interval in milliseconds. */
const POLL_INTERVAL = 3000;

/** Maximum number of activity events to keep in memory. */
const MAX_EVENTS = 200;

// =============================================================================
// MODULE-LEVEL SINGLETON STATE
// =============================================================================
// Shared across all consumers of the hook. Data survives view switches.
// =============================================================================

let _data: DashboardResponse | null = null;
let _events: ActivityEvent[] = [];
let _error: string | null = null;
let _refCount = 0;
let _intervalId: ReturnType<typeof setInterval> | null = null;
let _eventUnsub: (() => void) | null = null;
const _listeners = new Set<() => void>();

// Single source of truth for the singleton's run state, so the two lifecycle
// inputs (does anyone want data? is the shell connected?) can never desync. The
// previous per-hook `startedRef` could be left stranded `true` after a
// refCount-driven `_stop()` (e.g. React.StrictMode's mount→unmount→remount),
// permanently killing polling. `_reconcile()` derives the desired state from
// these two flags instead.
/** Whether the singleton is currently polling + subscribed. */
let _started = false;
/** Last-known shell connection state, mirrored from consumers. */
let _connected = false;

/** Immutable snapshot shape shared with subscribers via useSyncExternalStore. */
interface DashboardSnapshot {
	/** Latest dashboard snapshot, or null if not yet loaded. */
	data: DashboardResponse | null;
	/** Activity events (newest first). */
	events: ActivityEvent[];
	/** Last fetch failure, or null when healthy. */
	error: string | null;
}

// Explicitly annotated so control-flow analysis does not narrow the initial
// `data` to `null` at this declaration (the function that assigns `_data` is
// defined further down); without the annotation, the reassignment in `_emit`
// below would not type-check. Runtime behavior is unchanged.
/** Stable snapshot object — replaced whenever _emit() publishes a state update. */
let _snapshot: DashboardSnapshot = { data: _data, events: _events, error: _error };

/** Notify all subscribed React components that data changed. */
function _emit(): void {
	_snapshot = { data: _data, events: _events, error: _error };
	_listeners.forEach((fn) => fn());
}

/** The one in-flight dashboard request, shared by poll / initial / refresh. */
let _fetchPromise: Promise<void> | null = null;

/**
 * Fetch the latest dashboard snapshot.
 *
 * Deduplicated: the interval tick, the initial fetch, and manual refresh()
 * all funnel through the same in-flight promise, so a slow server cannot
 * accumulate overlapping requests (where an older response could land last
 * and overwrite newer data).
 */
function _fetchDashboard(): Promise<void> {
	if (_fetchPromise) return _fetchPromise;
	const client = getClient();
	if (!client || !client.isConnected()) return Promise.resolve();
	_fetchPromise = (async () => {
		try {
			const dashboard = await client.getDashboard();
			if (dashboard?.overview) {
				_data = dashboard;
				_error = null;
				_emit();
			}
		} catch (err) {
			// Surface the failure rather than only logging it. Swallowing it left
			// `_data` null, and consumers render their loading state whenever data
			// is null — so a permission denial was indistinguishable from a slow
			// load and the view sat on "Loading..." forever (saas #373).
			console.log('[useDashboardData] Dashboard fetch failed:', err);
			const message = err instanceof Error ? err.message : String(err);

			// getDashboard() goes through call(), so a structured DAP error arrives
			// as DAPException with the detail in `dapResult` — the human message is
			// not guaranteed to carry it. Matching prose alone therefore misses the
			// case this branch exists for: a real denial would keep rendering the
			// previous session's numbers under an "access denied" banner. Read the
			// structured status first and fall back to the text.
			const dapResult = (err as { dapResult?: Record<string, unknown> } | undefined)?.dapResult;
			const status = Number(dapResult?.status ?? dapResult?.statusCode ?? dapResult?.code);
			// `code` is not always numeric — the server may send a symbolic
			// 'UNAUTHORIZED' / 'FORBIDDEN', which Number() turns into NaN. Testing
			// only the numeric status and the prose would then miss the denial
			// whenever the human message is generic, which is precisely the failure
			// this branch exists to prevent: the previous session's figures would
			// stay on screen under a vague error. Match the code as text too.
			const code = String(dapResult?.code ?? '');
			const DENIAL = /denied|permission|forbidden|unauthori[sz]ed|not\s*authori[sz]ed|\b40[13]\b/i;
			const denied = status === 401 || status === 403 || DENIAL.test(code) || DENIAL.test(message);
			// The raw message already says "permission denied" in the case we most
			// want to explain, so prefixing it produced "You do not have permission
			// to view the dashboard. Permission denied". Replace it instead of
			// appending — the verbatim text stays in the console line above for
			// anyone debugging.
			_error = denied ? 'You do not have permission to view the dashboard.' : message;
			// Deliberate: `_data` is NOT cleared on a transient failure. A poll that
			// blips should leave the last good numbers on screen with an error
			// alongside them, not blank the dashboard every time the network hiccups
			// — going empty on each failed poll would be its own bug.
			//
			// A denial is different. It means this user is not entitled to these
			// numbers, and continuing to display a previous session's data under an
			// "access denied" banner is both confusing and the wrong default for
			// something access-scoped. So clear it in that case only.
			if (denied) {
				_data = null;
			}
			_emit();
		} finally {
			_fetchPromise = null;
		}
	})();
	return _fetchPromise;
}

/** Start polling and event subscription. */
function _start(): void {
	if (_intervalId) return;

	// Initial fetch
	_fetchDashboard();

	// Poll at interval
	_intervalId = setInterval(_fetchDashboard, POLL_INTERVAL);

	// Subscribe to live events
	_eventUnsub = ConnectionManager.getInstance().on('shell:event', ({ event }) => {
		const parsed = parseActivityEvent(event);
		if (parsed) {
			_events = [parsed, ..._events].slice(0, MAX_EVENTS);
			_emit();
		}
	});
}

/** Stop polling and event subscription. */
function _stop(): void {
	if (_intervalId) {
		clearInterval(_intervalId);
		_intervalId = null;
	}
	if (_eventUnsub) {
		_eventUnsub();
		_eventUnsub = null;
	}
}

/**
 * Start or stop the singleton so it runs exactly when it should: there is at
 * least one live consumer AND the shell is connected. Idempotent — called from
 * both the ref-count effect and the connection-state effect; only a real
 * transition touches the timer/subscription.
 */
function _reconcile(): void {
	// Poll only while something is mounted to receive the data and we can fetch.
	const shouldRun = _refCount > 0 && _connected;
	if (shouldRun && !_started) {
		_started = true;
		_start();
	} else if (!shouldRun && _started) {
		_started = false;
		_stop();
	}
}

// =============================================================================
// RETURN TYPE
// =============================================================================

/** Data returned by the useDashboardData hook. */
export interface DashboardData {
	/** Latest dashboard snapshot, or null if not yet loaded. */
	data: DashboardResponse | null;
	/** Activity events (newest first). */
	events: ActivityEvent[];
	/** Last fetch failure (e.g. a permission denial), or null when healthy. */
	error: string | null;
	/** Trigger a manual refresh. */
	refresh: () => void;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Shared hook that provides server dashboard data and activity events.
 *
 * Uses a module-level singleton: the first consumer starts polling, the last
 * one to unmount stops it. Data persists across view switches.
 *
 * @returns Dashboard data, events, and a manual refresh callback.
 */
export function useDashboardData(): DashboardData {
	const { isConnected } = useShellConnection();

	// Subscribe to module-level state changes via useSyncExternalStore.
	// The snapshot function returns a stable reference (_snapshot) that is
	// only replaced inside _emit(), preventing infinite re-render loops.
	const snapshot = useSyncExternalStore(
		(cb) => {
			_listeners.add(cb);
			return () => _listeners.delete(cb);
		},
		() => _snapshot
	);

	// Ref-count consumers; reconcile on every mount/unmount so the singleton
	// runs only while at least one consumer is alive. Reconcile (not a raw
	// _stop()) so a StrictMode remount re-derives the correct run state instead
	// of leaving polling dead.
	useEffect(() => {
		_refCount++;
		_reconcile();
		return () => {
			_refCount = Math.max(0, _refCount - 1);
			_reconcile();
		};
	}, []);

	// Mirror the shell connection state into the singleton and reconcile, so
	// polling starts on connect and stops on disconnect.
	useEffect(() => {
		_connected = isConnected;
		_reconcile();
	}, [isConnected]);

	/** Manually refresh the dashboard data. */
	const refresh = useCallback(() => {
		_fetchDashboard();
	}, []);

	return {
		data: snapshot.data,
		events: snapshot.events,
		error: snapshot.error,
		refresh,
	};
}
