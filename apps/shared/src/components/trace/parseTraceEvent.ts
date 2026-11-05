// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The `apaevt_flow` -> {@link TraceEvent} parse — OWNED by trace.
 *
 * Split out of the pipelines tool's `parseServerEvent`, which keeps the
 * `apaevt_status_update` branch and the continuum filter and calls this for
 * its trace case. Trace therefore parses its own events and depends on no
 * tool, while the tool's three other consumers are unchanged.
 */

import type { TraceEvent } from './types';

/**
 * Parses one `apaevt_flow` message body into a TraceEvent.
 *
 * Continuum stamps live in the BODY — the only place they exist (the DAP
 * envelope is pure protocol; session decode canonicalizes legacy recordings
 * into the body too). The folds have NO wall-clock fallback, so an event with
 * no body stamps (a pre-continuum server) is SKIPPED — passing it through
 * would seed NaN timestamps and unstable ordering downstream.
 *
 * @param body - The `apaevt_flow` message body.
 * @returns The trace event, or undefined when the body carries no stamps.
 */
export function parseTraceEvent(body: Record<string, any>): TraceEvent | undefined {
	const eventTime = body.eventTime;
	const seq = body.logSeq;
	if (!Number.isFinite(eventTime) || !Number.isFinite(seq)) return undefined;
	return {
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
}
