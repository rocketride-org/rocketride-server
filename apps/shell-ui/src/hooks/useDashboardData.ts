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
import { getClient } from '../lib/getClient';
import { parseActivityEvent } from 'shared';
import type { DashboardResponse, ActivityEvent } from 'shared';

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
}

// Explicitly annotated so control-flow analysis does not narrow the initial
// `data` to `null` at this declaration (the function that assigns `_data` is
// defined further down); without the annotation, the reassignment in `_emit`
// below would not type-check. Runtime behavior is unchanged.
/** Stable snapshot object — only replaced when data or events change. */
let _snapshot: DashboardSnapshot = { data: _data, events: _events };

/** Notify all subscribed React components that data changed. */
function _emit(): void {
	_snapshot = { data: _data, events: _events };
	_listeners.forEach(fn => fn());
}

/** Fetch the latest dashboard snapshot. */
async function _fetchDashboard(): Promise<void> {
	const client = getClient();
	if (!client || !client.isConnected()) return;
	try {
		const dashboard = await client.getDashboard();
		if (dashboard?.overview) {
			_data = dashboard;
			_emit();
		}
	} catch (err) {
		console.log('[useDashboardData] Dashboard fetch failed:', err);
	}
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
		(cb) => { _listeners.add(cb); return () => _listeners.delete(cb); },
		() => _snapshot,
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
		refresh,
	};
}
