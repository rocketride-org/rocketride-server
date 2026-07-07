// =============================================================================
// EVENTS-UI — Types
// =============================================================================

export interface CapturedEvent {
	/** Auto-incrementing ID */
	id: number;
	/** Capture timestamp (ms since epoch) */
	time: number;
	/** DAP event name (e.g. 'apaevt_status_update', 'apaevt_task') */
	eventName: string;
	/** Full DAP message body */
	body: Record<string, unknown>;
	/** Task token (if present) */
	token: string;
	/** DAP sequence number */
	seq: number;
}

export interface MonitorConfig {
	/** Token to monitor ('*' for all) */
	token: string;
	/** Selected event type names */
	types: string[];
	/** Whether monitoring is active */
	active: boolean;
}

/** Event type names available for subscription */
export const EVENT_TYPE_NAMES = [
	'DEBUGGER',
	'DETAIL',
	'SUMMARY',
	'OUTPUT',
	'FLOW',
	'TASK',
	'SSE',
	'DASHBOARD',
	'BILLING',
] as const;

export type EventTypeName = (typeof EVENT_TYPE_NAMES)[number];

/** Maximum events to keep in memory */
export const MAX_EVENTS = 10_000;
