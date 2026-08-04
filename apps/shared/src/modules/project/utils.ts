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
import type { ITaskStatus } from 'shell';

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
 * @param scope - Which continuum this parse serves. Hosts parsing the RAW
 *          connection firehose pass 'dev' (deploy events ride the same
 *          socket whenever a team-scoped subscription is open and must not
 *          paint the dev canvas); section folds parsing SESSION-delivered
 *          events pass their own runKind; 'any' (default) applies no
 *          continuum filter. An event with no runKind stamp passes every
 *          scope (pre-stamp recordings).
 * @returns Parsed result with optional statusUpdate and/or traceEvent.
 *          Returns empty object if the event is not relevant to this project.
 */
export function parseServerEvent(event: unknown, projectId: string, scope: 'dev' | 'deploy' | 'any' = 'any'): ParsedServerEvent {
	const msg = event as Record<string, any>;
	if (!msg?.event || !msg?.body) return {};

	const body = msg.body;

	// Continuum filter: only an EXPLICIT mismatching stamp excludes an
	// event — dev views drop deploy-run events and vice versa; unstamped
	// events (older recordings) pass everywhere.
	if (scope === 'dev' && body.runKind === 'deploy') return {};
	if (scope === 'deploy' && body.runKind === 'dev') return {};

	// --- Status update (apaevt_status_update) --------------------------------
	if (msg.event === 'apaevt_status_update' && body.project_id === projectId) {
		return { statusUpdate: { source: body.source, status: body as ITaskStatus } };
	}

	// --- Flow / trace event (apaevt_flow) ------------------------------------
	if (msg.event === 'apaevt_flow' && body.project_id === projectId) {
		// Continuum stamps live in the BODY — the only place they exist (the
		// DAP envelope is pure protocol; session decode canonicalizes legacy
		// recordings into the body too). The folds have NO wall-clock
		// fallback, so an event with no body stamps (a pre-continuum server)
		// is skipped — passing it through would seed NaN timestamps and
		// unstable ordering downstream.
		const eventTime = body.eventTime;
		const seq = body.logSeq;
		if (!Number.isFinite(eventTime) || !Number.isFinite(seq)) return {};
		const traceEvent: TraceEvent = {
			pipelineId: body.id ?? 0,
			op: body.op || 'enter',
			pipes: body.pipes || [],
			component: body.component,
			trace: body.op === 'end' ? {} : body.trace || {},
			source: body.source,
			eventTime,
			seq,
			...(body.op === 'end' && body.trace && Object.keys(body.trace).length > 0 ? { pipelineResult: body.trace } : {}),
		};
		return { traceEvent };
	}

	return {};
}

// =============================================================================
// DEV LIVE-FEED MEMBERSHIP
// =============================================================================

/**
 * Membership test for a host's DEV live-event feed.
 *
 * True when the event is a stamped task event (body carries the continuum
 * stamps), belongs to the given project, and is NOT a deploy-run event —
 * the single classification both hosts (rocket-ui provider and the VS Code
 * bridge) apply before appending to their liveLogEvents arrays. Deploy-run
 * events reach deploy views through team-scoped DVR sessions, never the
 * dev feed.
 *
 * @param event - Raw event object from the server WebSocket.
 * @param projectId - Current project ID to filter events by.
 * @returns True when the event belongs in the dev live feed.
 */
export function isDevLiveEvent(event: unknown, projectId: string): boolean {
	const msg = event as Record<string, any>;
	const body = msg?.body;
	if (!body) return false;
	if (body.runKind === 'deploy') return false;
	if (!Number.isFinite(body.eventTime) || !Number.isFinite(body.logSeq)) return false;
	return body.project_id === projectId;
}

/**
 * Membership test for a TEAM deployment's live-event feed.
 *
 * The deploy-scope twin of {@link isDevLiveEvent}: true when the event is a
 * stamped task event, belongs to the given project, and is THIS team's
 * deploy run (the stamped body carries the OWNER team for deploy runs).
 * Hosts feed the deploy record panels from this filter.
 *
 * @param event - Raw event object from the server WebSocket.
 * @param projectId - The deployed project.
 * @param teamId - The deployment's owning team.
 * @returns True when the event belongs in the team's deploy live feed.
 */
export function isTeamLiveEvent(event: unknown, projectId: string, teamId: string): boolean {
	const msg = event as Record<string, any>;
	const body = msg?.body;
	if (!body) return false;
	if (body.runKind !== 'deploy' || body.teamId !== teamId) return false;
	if (!Number.isFinite(body.eventTime) || !Number.isFinite(body.logSeq)) return false;
	return body.project_id === projectId;
}
