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

import type { PIPELINE_RESULT } from './data.js';

/**
 * Event type enumeration for sophisticated client subscription and event routing.
 *
 * This enumeration defines event categories used for intelligent event filtering
 * and routing in multi-client environments. It enables clients to subscribe
 * to specific types of events based on their needs and capabilities, reducing
 * network traffic and improving system performance.
 *
 * Event Categories:
 * ----------------
 * NONE: Unsubscribe from all events (cleanup and disconnection)
 * ALL: Subscribe to all events regardless of category (comprehensive monitoring)
 * DEBUGGER: Debug-specific events for debugging protocol communication
 * DETAIL: Real-time processing events requiring immediate client attention
 * SUMMARY: Periodic status summaries suitable for dashboard monitoring
 * OUTPUT: Standard output and logging messages
 * FLOW: Pipeline flow events - component execution tracking
 * TASK: Task lifecycle events - start, stop, state changes
 *
 * Subscription Strategies:
 * -----------------------
 * NONE: Used during client disconnection to stop all event delivery
 *       and perform cleanup of monitoring subscriptions.
 *
 * ALL: Comprehensive monitoring for administrative clients that need
 *      complete visibility into task execution and debugging activities.
 *
 * DEBUGGER: Debug protocol events including breakpoint hits, variable
 *           changes, stack traces, and debugging session management.
 *
 * DETAIL: Real-time processing events including object processing updates,
 *         error/warning messages, metrics updates, and immediate status
 *         changes requiring client response or display updates.
 *
 * SUMMARY: Periodic status summaries sent at CONST_STATUS_UPDATE_FREQ
 *          intervals containing complete task status, suitable for
 *          monitoring dashboards and periodic client updates.
 *
 * OUTPUT: Standard output and logging messages from task execution.
 *
 * FLOW: Pipeline flow events tracking component execution, data flow
 *       between pipeline stages, and processing pipeline status.
 *
 * TASK: Task lifecycle events including task start, stop, pause, resume,
 *       and state changes for task management interfaces.
 *
 * Network Optimization:
 * --------------------
 * Event filtering reduces network traffic by sending only relevant events
 * to interested clients. SUMMARY subscriptions receive consolidated status
 * updates rather than individual processing events, significantly reducing
 * bandwidth usage for monitoring applications.
 *
 * Multi-Client Support:
 * --------------------
 * Different clients can subscribe to different event types simultaneously:
 * - Debugging clients: DEBUGGER + DETAIL for comprehensive debugging
 * - Monitoring dashboards: SUMMARY for efficient status tracking
 * - Administrative tools: ALL for complete system visibility
 * - Log viewers: OUTPUT for message monitoring
 * - Pipeline managers: FLOW + TASK for execution tracking
 *
 * @example
 * ```typescript
 * // Subscribe to debugging and detail events
 * const subscription = EVENT_TYPE.DEBUGGER | EVENT_TYPE.DETAIL;
 *
 * // Check if client wants specific events
 * if (clientSubscription & EVENT_TYPE.SUMMARY) {
 *     sendSummaryUpdate(client, taskStatus);
 * }
 * ```
 */
export enum EVENT_TYPE {
	/** No events - unsubscribe from all event types */
	NONE = 0,

	/** Debug protocol events - DAP and debugging-specific events like breakpoints, stack traces */
	DEBUGGER = 1 << 0, // Binary: 000001

	/** Real-time processing events - immediate updates for live monitoring */
	DETAIL = 1 << 1, // Binary: 000010

	/** Periodic status summaries - dashboard monitoring with reduced frequency */
	SUMMARY = 1 << 2, // Binary: 000100

	/** Standard output and logging messages from task execution */
	OUTPUT = 1 << 3, // Binary: 001000

	/** Pipeline flow events - component execution tracking and data flow visualization */
	FLOW = 1 << 4, // Binary: 010000

	/** Task lifecycle events - start, stop, state changes, and task management */
	TASK = 1 << 5,

	/** Real-time node-to-UI messages emitted via monitorSSE() during pipeline execution */
	SSE = 1 << 6,

	/** Server-level events - connection added/removed, for admin dashboards */
	DASHBOARD = 1 << 7,

	/** Convenience combination - ALL events except NONE for comprehensive monitoring */
	ALL = DEBUGGER | DETAIL | SUMMARY | OUTPUT | FLOW | TASK | SSE | DASHBOARD,
}

/**
 * DAP event for task lifecycle management with discriminated union for type safety.
 *
 * This event handles three distinct task lifecycle scenarios using TypeScript's
 * discriminated unions to provide strict type safety and prevent invalid field
 * combinations. Each action type has its own required fields and structure.
 *
 * Action Types:
 * - 'running': Lists all currently running tasks for the client's API key
 * - 'begin': Notifies that a new task has started execution
 * - 'end': Notifies that a task has completed or terminated
 *
 * Event Flow:
 * 1. Client subscribes to EVENT_TYPE.TASK
 * 2. Server immediately sends 'running' action with current task list
 * 3. As tasks start/stop, server sends 'begin'/'end' actions
 *
 * Network Optimization:
 * - 'running' action sent only once per subscription to provide initial state
 * - 'begin'/'end' actions sent as lightweight notifications
 * - Only tasks belonging to client's API key are included
 *
 * @example
 * ```typescript
 * function handleTaskEvent(event: { body: TaskEvent }): void {
 *     if (event.body.action === 'running') {
 *         console.log(`Found ${event.body.tasks.length} running tasks`);
 *         event.body.tasks.forEach(task => {
 *             console.log(`Task ${task.id} in project ${task.projectId}`);
 *         });
 *     } else {
 *         console.log(`Task ${event.body.name} has ${event.body.action}`);
 *         console.log(`Project: ${event.body.projectId}, Source: ${event.body.source}`);
 *     }
 * }
 * ```
 */
/** Task info entry in the 'running' action payload. */
interface TaskRunningEntry {
	/** Unique task identifier. */
	id: string;
	/** Display name of the task (e.g. 'Parser1.Chat'). */
	name: string;
	/** Project identifier. */
	projectId: string;
	/** Source component entry point. */
	source: string;
}

/** Snapshot of all active tasks, sent on initial subscription. */
interface TaskEventRunning {
	action: 'running';
	tasks: TaskRunningEntry[];
}

/** A task has started execution. */
interface TaskEventBegin {
	action: 'begin';
	/** Display name of the task. */
	name: string;
	/** Project identifier. */
	projectId: string;
	/** Source component identifier. */
	source: string;
}

/** A task has completed or been terminated. */
interface TaskEventEnd {
	action: 'end';
	/** Display name of the task. */
	name: string;
	/** Project identifier. */
	projectId: string;
	/** Source component identifier. */
	source: string;
}

/** A task has been restarted. */
interface TaskEventRestart {
	action: 'restart';
	/** Display name of the task. */
	name: string;
	/** Project identifier. */
	projectId: string;
	/** Source component identifier. */
	source: string;
}

/** Discriminated union of all apaevt_task event body shapes. */
export type TaskEvent = TaskEventRunning | TaskEventBegin | TaskEventEnd | TaskEventRestart;

/**
 * DAP event for pipeline flow tracking — component execution and data flow visualization.
 *
 * Sent during pipeline execution to track data flowing through components.
 * Each event represents a pipeline operation (begin, enter, leave, end) on
 * a specific pipe within the pipeline.
 *
 * Client Subscriptions:
 * - FLOW: Pipeline execution tracking
 * - ALL: Comprehensive monitoring
 */
export interface TaskEventFlow {
	/** Pipe index within the pipeline. */
	id: number;

	/** Operation type. */
	op: 'begin' | 'enter' | 'leave' | 'end';

	/** Component names in the current pipe's execution path. */
	pipes: string[];

	/** Trace data — lane, input/output data, result, error. */
	trace: {
		lane?: string;
		data?: Record<string, unknown>;
		result?: string;
		error?: string;
	};

	/**
	 * Final pipeline result — populated on op === 'end' when trace level >= summary.
	 * Contains result_types mapping plus dynamic fields (text, answers, documents, etc.).
	 */
	result?: PIPELINE_RESULT;

	/** Project identifier. */
	project_id: string;

	/** Source component identifier (e.g. "chat_1"). */
	source: string;
}
