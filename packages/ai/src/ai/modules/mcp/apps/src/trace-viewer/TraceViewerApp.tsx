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

import { RequestRow } from '@app-shared/components/trace';
import { TraceDetail } from '@app-shared/components/trace';

import { parseListPayload, type ListPayload, type ToolContext } from './adapter';
import { makeFetchTrace, type PrefetchedTrace } from './fetch-trace';
import { parseToolJson, ToolError } from './tool-json';

/** Scroll caps, in px (see the note on `shell` for why not vh/%). */
const LIST_MAX_HEIGHT = 420;
const DETAIL_MAX_HEIGHT = 640;

const S: Record<string, React.CSSProperties> = {
	// Height is content-driven end to end: the host's auto-resize measures
	// this document with `html { height: max-content }` and resizes the
	// iframe to match. Caps MUST therefore be in pixels, never vh/% — a
	// viewport-relative cap shrinks as the iframe shrinks, clamping the
	// content that produced the measurement, and the widget collapses to
	// nothing over successive resize rounds.
	// No background here: .rr-card's surface shows through, matching the
	// sibling widgets. Rows and the call tree paint their own backgrounds.
	shell: {
		display: 'flex',
		flexDirection: 'column',
		color: 'var(--rr-text-primary)',
		fontFamily: 'var(--rr-font-family)',
		fontSize: 14,
	},
	// .rr-card supplies the border/radius/surface; zero its padding so rows
	// and the call tree run edge to edge, clipped by the radius.
	card: { padding: 0, overflow: 'hidden' },
	list: { overflowY: 'auto', maxHeight: LIST_MAX_HEIGHT, minWidth: 0 },
	note: { padding: '6px 10px', fontSize: 12, color: 'var(--rr-text-secondary)' },
	bar: {
		display: 'flex',
		flexWrap: 'wrap',
		alignItems: 'center',
		gap: 6,
		padding: '6px 10px',
		borderBottom: '1px solid var(--rr-line)',
		flexShrink: 0,
	},
	barTitle: { flex: 1, fontSize: 12, whiteSpace: 'nowrap', color: 'var(--rr-text-secondary)' },
	// Prev, Next and Retry stay together; in a narrow column they wrap as one
	// group to a second row, right-aligned.
	barNav: { display: 'flex', gap: 6, marginLeft: 'auto' },
	detail: { overflowY: 'auto', maxHeight: DETAIL_MAX_HEIGHT, minWidth: 0 },
};

interface ParsedInitial {
	list?: ListPayload;
	prefetched?: PrefetchedTrace;
	context?: ToolContext;
	error?: string;
	errorType?: string;
}

/** An aged-out or missing trace is an expected state, not a failure. */
const NOTICE_ERROR_TYPES = new Set(['TraceExpired', 'NotFound']);

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
		return {
			error: err instanceof Error ? err.message : String(err),
			errorType: err instanceof ToolError ? err.errorType : undefined,
		};
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
		// Server failures arrive already in plain words (friendlyToolError); anything
		// else here (a malformed result, missing context) is for the console.
		const notice = initial.errorType !== undefined && NOTICE_ERROR_TYPES.has(initial.errorType);
		const plain = initial.errorType !== undefined;
		if (!plain) console.error('trace viewer:', initial.error ?? 'unexpected tool result');
		return (
			<p className={notice ? 'rr-message rr-notice' : 'rr-message rr-message-error'}>
				{plain ? initial.error : 'The trace could not be read. Try again.'}
			</p>
		);
	}

	const order = initial.list?.summaries.map((s) => s.beginSeq).filter((seq): seq is number => seq !== null) ?? [];
	const index = selected !== null ? order.indexOf(selected) : -1;

	if (selected !== null) {
		return (
			<section className="rr-card" style={{ ...S.shell, ...S.card }}>
				<div style={S.bar}>
					{initial.list && (
						<button className="rr-btn rr-btn-ghost" onClick={() => setSelected(null)}>
							← All requests
						</button>
					)}
					<span style={S.barTitle}>{index >= 0 ? `Request ${index + 1} of ${order.length}` : `Trace ${selected}`}</span>
					<span style={S.barNav}>
						{order.length > 1 && (
							<>
								<button className="rr-btn" disabled={index <= 0} onClick={() => setSelected(order[index - 1])}>
									Prev
								</button>
								<button className="rr-btn" disabled={index < 0 || index >= order.length - 1} onClick={() => setSelected(order[index + 1])}>
									Next
								</button>
							</>
						)}
						<button className="rr-btn" onClick={() => setRetryKey((k) => k + 1)} title="Re-fetch this trace">
							Retry
						</button>
					</span>
				</div>
				<div style={S.detail}>
					<TraceDetail key={retryKey} traceId={selected} projectId={initial.context.projectId} fetchTrace={fetchTrace} />
				</div>
			</section>
		);
	}

	const list = initial.list as ListPayload;
	if (list.summaries.length === 0) {
		return (
			<p className="rr-message">There are no traces to show yet. Run the pipeline, then open its traces again.</p>
		);
	}
	return (
		<section className="rr-card" style={{ ...S.shell, ...S.card }}>
			{list.note && <div style={S.note}>{list.note}</div>}
			<div className="rr-trace-list" style={S.list}>
				{list.summaries.map((summary) => (
					<RequestRow key={summary.docId} summary={summary} onOpen={summary.beginSeq !== null ? () => setSelected(summary.beginSeq) : undefined} />
				))}
			</div>
		</section>
	);
};
