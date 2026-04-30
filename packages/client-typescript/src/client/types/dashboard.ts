/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Dashboard Types for RocketRide Server Monitor.
 *
 * Type definitions for the rrext_dashboard DAP command response and
 * server-level dashboard push events (apaevt_dashboard).
 */

/** Server-level aggregate metrics (scoped to the caller's account). */
export interface DashboardOverview {
	/** Number of currently active WebSocket connections for this account. */
	totalConnections: number;
	/** Number of tasks currently in the registry for this account. */
	activeTasks: number;
	/** Seconds since server started. */
	serverUptime: number;
}

/** Details for a single active WebSocket connection. */
export interface DashboardConnection {
	/** Unique monotonic connection identifier. */
	id: number;
	/** Unix timestamp when connection was established. */
	connectedAt: number;
	/** Unix timestamp of last received message. */
	lastActivity: number;
	/** Total messages received from this client. */
	messagesIn: number;
	/** Total messages sent to this client. */
	messagesOut: number;
	/** Whether the connection has completed auth. */
	authenticated: boolean;
	/** AccountInfo.clientid (account identifier). */
	clientId: string | null;
	/** Masked API key (first 4 + last 4 chars). */
	apikey: string;
	/** Client name/version from auth handshake. */
	clientInfo: Record<string, string>;
	/** Active monitor subscriptions with their event flags. */
	monitors: { key: string; flags: string[] }[];
	/** Task display names this connection is monitoring. */
	attachedTasks: string[];
}

/** Details for a single managed task. */
export interface DashboardTask {
	/** Internal task identifier (token[:8].source). */
	id: string;
	/** Display name (pipeline filename, config name, or source ID). */
	name: string;
	/** Project identifier. */
	projectId: string;
	/** Source component identifier. */
	source: string;
	/** Provider name. */
	provider: string;
	/** 'launch' or 'execute'. */
	launchType: string;
	/** Unix timestamp when task was created. */
	startTime: number;
	/** Runtime duration in seconds. */
	elapsedTime: number;
	/** Whether the task has finished. */
	completed: boolean;
	/** Current status message (running tasks only). */
	status: string | null;
	/** Exit code (completed tasks only). */
	exitCode: number | null;
	/** Unix timestamp of completion (completed tasks only). */
	endTime: number | null;
	/** Number of attached client connections. */
	connections: number;
	/** TASK_STATE enum value. */
	state: number;
	/** Seconds since last activity. */
	idleTime: number;
	/** Time-to-live in seconds (0 = no timeout). */
	ttl: number;
	/** Performance metrics (timers, counters). */
	metrics: Record<string, unknown> | null;
	/** Total items to process. */
	totalCount: number;
	/** Items completed so far. */
	completedCount: number;
	/** Current processing rate (items/sec). */
	rateCount: number;
	/** Current processing rate (bytes/sec). */
	rateSize: number;
}

/** Complete response from the rrext_dashboard command. */
export interface DashboardResponse {
	overview: DashboardOverview;
	connections: DashboardConnection[];
	tasks: DashboardTask[];
}

/** Base fields shared by all dashboard events. */
interface DashboardEventBase {
	/** Unix timestamp when the event occurred. */
	timestamp: number;
}

/** A new connection authenticated with the server. */
interface DashboardConnectionAdded extends DashboardEventBase {
	action: 'connection_added';
	/** Unique monotonic connection identifier. */
	connectionId: number;
	/** Client display name from auth handshake. */
	clientName?: string | null;
	/** Client version from auth handshake. */
	clientVersion?: string | null;
	/** Account identifier. */
	clientId?: string | null;
}

/** A connection was closed. */
interface DashboardConnectionRemoved extends DashboardEventBase {
	action: 'connection_removed';
	/** Unique monotonic connection identifier. */
	connectionId: number;
	/** Client display name from auth handshake. */
	clientName?: string | null;
	/** Client version from auth handshake. */
	clientVersion?: string | null;
}

/** A task was started or restarted. */
interface DashboardTaskStarted extends DashboardEventBase {
	action: 'task_started';
	/** Task display identifier. */
	taskId: string;
}

/** A task stopped (completed or errored). */
interface DashboardTaskStopped extends DashboardEventBase {
	action: 'task_stopped';
	/** Task display identifier. */
	taskId: string;
}

/** A completed task was cleaned up from the registry. */
interface DashboardTaskRemoved extends DashboardEventBase {
	action: 'task_removed';
	/** Task display identifier. */
	taskId: string;
}

/** A task exited with a non-zero exit code. */
interface DashboardTaskError extends DashboardEventBase {
	action: 'task_error';
	/** Task display identifier. */
	taskId: string;
	/** Process exit code. */
	exitCode: number;
	/** Exit message from the engine. */
	exitMessage?: string | null;
}

/** An authentication attempt failed. */
interface DashboardAuthFailed extends DashboardEventBase {
	action: 'auth_failed';
	/** Unique monotonic connection identifier. */
	connectionId: number;
	/** Reason the auth was rejected. */
	reason: string;
}

/** A monitor subscription changed on a connection. */
interface DashboardMonitorChanged extends DashboardEventBase {
	action: 'monitor_changed';
	/** Unique monotonic connection identifier. */
	connectionId: number;
	/** Client display name from auth handshake. */
	clientName?: string | null;
	/** Client version from auth handshake. */
	clientVersion?: string | null;
	/** The monitor key that changed. */
	key: string;
	/** Whether the monitor was added or removed. */
	change: 'subscribed' | 'unsubscribed';
}

/** Discriminated union of all dashboard activity events. */
export type DashboardEvent = DashboardConnectionAdded | DashboardConnectionRemoved | DashboardTaskStarted | DashboardTaskStopped | DashboardTaskRemoved | DashboardTaskError | DashboardAuthFailed | DashboardMonitorChanged;
