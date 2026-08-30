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
// EVENTS-UI — TYPES
// =============================================================================

/**
 * One captured DAP event, held in the capture engine's in-memory ring buffer.
 * Distinct from {@link EventRow}: this is the raw record; the row is its
 * flattened, grid-facing projection.
 */
export interface CapturedEvent {
	/** Auto-incrementing capture id (stable identity for the grid + panel). */
	id: number;
	/** Capture timestamp (epoch milliseconds, recorded on receipt). */
	time: number;
	/** DAP event name (e.g. 'apaevt_status_update', 'apaevt_task'). */
	eventName: string;
	/** Full DAP message body. */
	body: Record<string, unknown>;
	/** Task token, or '' when the event carries none. */
	token: string;
	/** DAP sequence number. */
	seq: number;
}

/**
 * Grid row shape for the Event Stream {@link CardDataGrid}. The declared
 * columns read the scalar fields; `body` rides along undeclared so the row
 * click can hand the full payload to the {@link EventDetailPanel} without a
 * second lookup.
 */
export interface EventRow extends Record<string, unknown> {
	/** Capture id (hidden-by-default '#' column; the React key). */
	id: number;
	/** Capture time in epoch milliseconds (default sort, newest first). */
	time: number;
	/** DAP event name (colored by the chart-token map). */
	eventName: string;
	/** Task token, or '' when absent. */
	token: string;
	/** DAP sequence number (hidden by default). */
	seq: number;
	/** One-line body summary derived at row-build time. */
	summary: string;
	/** Full DAP body, carried for the detail panel (not a declared column). */
	body: Record<string, unknown>;
}

/**
 * The capture engine's published snapshot — a new object on each 4 Hz tick
 * that actually changed something, so the grid re-applies its rows and the
 * MiniCards re-read their metrics without per-event re-renders.
 */
export interface CaptureSnapshot {
	/** Current grid rows (new identity only when the buffer changed). */
	rows: EventRow[];
	/** Total events captured this session (survives the ring-buffer cap). */
	total: number;
	/** Events currently retained in the ring buffer. */
	inMemory: number;
	/** Events observed in the trailing one-second window (events/sec). */
	rate: number;
}

/** Monitor configuration — the subscription key plus the run flag. */
export interface MonitorConfig {
	/** Token to monitor ('*' for all tasks). */
	token: string;
	/** Selected subscription category names ({@link EVENT_TYPE_NAMES}). */
	types: string[];
	/** Whether monitoring is active. */
	active: boolean;
}

/** Event subscription category names available for monitoring. */
export const EVENT_TYPE_NAMES = ['DEBUGGER', 'DETAIL', 'SUMMARY', 'OUTPUT', 'FLOW', 'TASK', 'SSE', 'DASHBOARD', 'BILLING'] as const;

/** One subscription category name. */
export type EventTypeName = (typeof EVENT_TYPE_NAMES)[number];

/** Maximum events retained in the in-memory ring buffer. */
export const MAX_EVENTS = 1_000;

/**
 * Trailing-throttle coalesce interval (ms). A burst of pushed events collapses
 * into at most one grid + metrics update per this window; the throttle is
 * armed by event arrival (and a short decay tail), never a perpetual timer.
 */
export const FLUSH_INTERVAL_MS = 250;
