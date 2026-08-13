/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * log_traces payload → the in-app list's TraceRequestSummary shape
 * (structurally — no import, so unit tests need no bundler aliases).
 * Units: the tool reports epoch SECONDS (beginTime) and SECONDS (elapsed);
 * the components expect epoch MS and MS. Summaries carry no error flag, so
 * hasError is always false here (the detail view still shows call errors).
 */
import { ToolError } from './tool-json';

export interface LogTraceSummary {
	id?: unknown;
	beginSeq?: number;
	doc?: string;
	beginTime?: number;
	elapsed?: number;
	calls?: number;
	open?: boolean;
}

export interface ToolContext {
	projectId: string;
	source: string;
	teamId?: string;
}

export interface RequestSummary {
	docId: number;
	beginSeq: number | null;
	objectName: string;
	hasError: boolean;
	inFlight: boolean;
	totalElapsed: number | null;
	beginTimestamp: number | null;
	totalCalls: number;
}

export interface ListPayload {
	context: ToolContext;
	summaries: RequestSummary[];
	note?: string;
}

function toRequestSummary(s: LogTraceSummary, inFlight: boolean): RequestSummary {
	return {
		docId: s.beginSeq ?? -1,
		beginSeq: s.beginSeq ?? null,
		objectName: s.doc || '<unknown>',
		hasError: false,
		inFlight,
		totalElapsed: typeof s.elapsed === 'number' ? s.elapsed * 1000 : null,
		beginTimestamp: typeof s.beginTime === 'number' ? s.beginTime * 1000 : null,
		totalCalls: s.calls ?? 0,
	};
}

export function parseListPayload(payload: Record<string, unknown>): ListPayload {
	const context = payload.context as ToolContext | undefined;
	if (!context?.projectId || !context?.source) {
		throw new ToolError('tool result is missing its keying context (projectId/source) — server too old?');
	}
	const closed = (Array.isArray(payload.traces) ? payload.traces : []) as LogTraceSummary[];
	const open = (Array.isArray(payload.open) ? payload.open : []) as LogTraceSummary[];
	const summaries = [...closed.map((s) => toRequestSummary(s, false)), ...open.map((s) => toRequestSummary(s, true))].sort(
		(a, b) => (a.beginSeq ?? 0) - (b.beginSeq ?? 0),
	);
	return { context, summaries, note: typeof payload.note === 'string' ? payload.note : undefined };
}
