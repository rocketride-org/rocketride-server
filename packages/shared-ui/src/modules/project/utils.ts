// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Server event parsing utilities for ProjectView hosts.
 *
 * Extracts status updates and trace events from raw server WebSocket events.
 * Used by both the rocket-ui provider (direct mount) and the VS Code bridge.
 */

import type { TraceEvent } from './types';
import type { ITaskStatus } from '../../types/project';

// =============================================================================
// TYPES
// =============================================================================

/** Result of parsing a raw server event for the project module. */
export interface ParsedServerEvent {
	/** Status update for a specific source — merge into the host's statusMap. */
	statusUpdate?: { source: string; status: ITaskStatus };
	/** Trace event — append to the host's traceEvents array. */
	traceEvent?: TraceEvent;
}

// =============================================================================
// PARSER
// =============================================================================

/**
 * Parse a raw server event into project-relevant updates.
 *
 * @param event - Raw event object from the server WebSocket (event.body shape).
 * @param projectId - Current project ID to filter events by.
 * @returns Parsed result with optional statusUpdate and/or traceEvent.
 *          Returns empty object if the event is not relevant to this project.
 */
export function parseServerEvent(event: unknown, projectId: string): ParsedServerEvent {
	const msg = event as Record<string, any>;
	if (!msg?.event || !msg?.body) return {};

	const body = msg.body;

	// --- Status update (apaevt_status_update) --------------------------------
	if (msg.event === 'apaevt_status_update' && body.project_id === projectId) {
		return { statusUpdate: { source: body.source, status: body as ITaskStatus } };
	}

	// --- Flow / trace event (apaevt_flow) ------------------------------------
	if (msg.event === 'apaevt_flow' && body.project_id === projectId) {
		const traceEvent: TraceEvent = {
			pipelineId: body.id ?? 0,
			op: body.op || 'enter',
			pipes: body.pipes || [],
			trace: body.op === 'end' ? {} : body.trace || {},
			source: body.source,
			...(body.op === 'end' && body.trace && Object.keys(body.trace).length > 0 ? { pipelineResult: body.trace } : {}),
		};
		return { traceEvent };
	}

	return {};
}
