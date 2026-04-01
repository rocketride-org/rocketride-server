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

/** Server-level aggregate metrics. */
export interface DashboardOverview {
	/** Number of currently active WebSocket connections. */
	totalConnections: number;
	/** Number of tasks currently in the registry. */
	activeTasks: number;
	/** Historical maximum concurrent task count. */
	peakTasks: number;
	/** Lifetime total of created tasks. */
	totalTasksLifetime: number;
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
	/** Task IDs this connection is monitoring. */
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

/** Pushed event body from apaevt_dashboard server events. */
export interface DashboardEvent {
	/** Event action name. */
	action: 'connection_added' | 'connection_removed' | 'task_started' | 'task_stopped' | 'task_removed';
	/** Unix timestamp when the event occurred. */
	timestamp: number;
	/** Connection ID (for connection events). */
	connectionId?: number;
	/** Task ID (for task events). */
	taskId?: string;
}
