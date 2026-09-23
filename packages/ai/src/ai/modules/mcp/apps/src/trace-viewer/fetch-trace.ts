/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Binds TraceDetail's injected fetchTrace to the MCP Apps tool bridge —
 * the in-app host binds session.getTrace here; we call the log_trace tool.
 * log_trace's { events } is already ITraceFetchResult-shaped (verified
 * against tools/logs.py + TraceDetail.tsx, 2026-08-12).
 */
import type { ToolContext } from './adapter';
import { parseToolJson } from './tool-json';

export interface TraceEvents {
	events: Array<{ event: string; body: Record<string, unknown> & { eventTime: number; logSeq: number }; [key: string]: unknown }>;
}

export interface PrefetchedTrace extends TraceEvents {
	beginSeq: number;
}

type CallServerTool = (params: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;

export function makeFetchTrace(callServerTool: CallServerTool, context: ToolContext, prefetched?: PrefetchedTrace) {
	return async (traceId: number): Promise<TraceEvents> => {
		if (prefetched && prefetched.beginSeq === traceId) {
			return { events: prefetched.events };
		}
		const args: Record<string, unknown> = { projectId: context.projectId, source: context.source, beginSeq: traceId };
		if (context.teamId) args.teamId = context.teamId;
		const payload = parseToolJson(await callServerTool({ name: 'log_trace', arguments: args }));
		return { events: (payload.events as TraceEvents['events']) ?? [] };
	};
}
