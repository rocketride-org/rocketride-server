/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * List/detail shell around the shared trace components. List rows are the
 * app's own RequestRow fed from log_traces summaries; the detail view
 * mounts the shared TraceDetail with fetchTrace bridged to log_trace.
 * A direct log_trace tool result (payload carries events) opens straight
 * into the detail view with the events prefetched — no second bridge call.
 */
import type { App } from '@modelcontextprotocol/ext-apps';
import React, { useMemo, useState } from 'react';

import { RequestRow } from '@app-shared/components/trace/Trace';
import { TraceDetail } from '@app-shared/components/trace/TraceDetail';
import { EmptyState } from 'shell';

import { parseListPayload, type ListPayload, type ToolContext } from './adapter';
import { makeFetchTrace, type PrefetchedTrace } from './fetch-trace';
import { parseToolJson, ToolError } from './tool-json';

const S: Record<string, React.CSSProperties> = {
	shell: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		color: 'var(--rr-text-primary)',
		background: 'var(--rr-bg-surface)',
		fontFamily: 'var(--rr-font-family)',
		fontSize: 13,
	},
	list: { flex: 1, overflowY: 'auto', minWidth: 0 },
	note: { padding: '6px 10px', fontSize: 11, color: 'var(--rr-text-secondary)' },
	error: { padding: 12, color: 'var(--rr-color-error)' },
	bar: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '6px 10px',
		borderBottom: '1px solid var(--rr-bg-widget)',
		flexShrink: 0,
	},
	barTitle: { flex: 1, fontSize: 11, color: 'var(--rr-text-secondary)' },
	btn: {
		font: 'inherit',
		fontSize: 11,
		padding: '2px 8px',
		cursor: 'pointer',
		color: 'var(--rr-text-primary)',
		background: 'var(--rr-bg-surface-alt)',
		border: '1px solid var(--rr-bg-widget)',
		borderRadius: 3,
	},
	detail: { flex: 1, overflowY: 'auto', minWidth: 0 },
};

interface ParsedInitial {
	list?: ListPayload;
	prefetched?: PrefetchedTrace;
	context?: ToolContext;
	error?: string;
}

/** log_trace payloads carry events+beginSeq; log_traces payloads carry traces/open. */
function parseInitial(result: unknown): ParsedInitial {
	try {
		const payload = parseToolJson(result);
		if (Array.isArray(payload.events) && typeof payload.beginSeq === 'number') {
			const context = payload.context as ToolContext | undefined;
			if (!context?.projectId || !context?.source) {
				throw new ToolError('tool result is missing its keying context (projectId/source) — server too old?');
			}
			return {
				prefetched: { beginSeq: payload.beginSeq, events: payload.events as PrefetchedTrace['events'] },
				context,
			};
		}
		const list = parseListPayload(payload);
		return { list, context: list.context };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export interface TraceViewerAppProps {
	app: App;
	initialResult: unknown;
}

export const TraceViewerApp: React.FC<TraceViewerAppProps> = ({ app, initialResult }) => {
	const initial = useMemo(() => parseInitial(initialResult), [initialResult]);
	const [selected, setSelected] = useState<number | null>(initial.prefetched?.beginSeq ?? null);
	// Bumped by the Retry button to remount TraceDetail (via `key`) and force
	// a fresh fetchTrace call — TraceDetail only refetches on its own when
	// `traceId` changes, so a failed fetch for the *same* trace has no other
	// way to retry.
	const [retryKey, setRetryKey] = useState(0);

	const fetchTrace = useMemo(() => {
		if (!initial.context) return null;
		return makeFetchTrace((params) => app.callServerTool(params), initial.context, initial.prefetched);
	}, [app, initial]);

	if (initial.error || !fetchTrace || !initial.context) {
		return <div style={S.error}>{initial.error ?? 'unexpected tool result'}</div>;
	}

	const order = initial.list?.summaries.map((s) => s.beginSeq).filter((seq): seq is number => seq !== null) ?? [];
	const index = selected !== null ? order.indexOf(selected) : -1;

	if (selected !== null) {
		return (
			<section style={S.shell}>
				<div style={S.bar}>
					{initial.list && (
						<button style={S.btn} onClick={() => setSelected(null)}>
							← All requests
						</button>
					)}
					<span style={S.barTitle}>{index >= 0 ? `Request ${index + 1} of ${order.length}` : `Trace ${selected}`}</span>
					{order.length > 1 && (
						<>
							<button style={S.btn} disabled={index <= 0} onClick={() => setSelected(order[index - 1])}>
								Prev
							</button>
							<button style={S.btn} disabled={index < 0 || index >= order.length - 1} onClick={() => setSelected(order[index + 1])}>
								Next
							</button>
						</>
					)}
					<button style={S.btn} onClick={() => setRetryKey((k) => k + 1)} title="Re-fetch this trace">
						Retry
					</button>
				</div>
				<div style={S.detail}>
					<TraceDetail key={retryKey} traceId={selected} projectId={initial.context.projectId} fetchTrace={fetchTrace} />
				</div>
			</section>
		);
	}

	const list = initial.list as ListPayload;
	if (list.summaries.length === 0) {
		return <EmptyState title="No trace data" description={list.note ?? 'Run the pipeline, then call log_traces again.'} />;
	}
	return (
		<section style={S.shell}>
			{list.note && <div style={S.note}>{list.note}</div>}
			<div style={S.list}>
				{list.summaries.map((summary) => (
					<RequestRow key={summary.docId} summary={summary} onOpen={summary.beginSeq !== null ? () => setSelected(summary.beginSeq) : undefined} />
				))}
			</div>
		</section>
	);
};
