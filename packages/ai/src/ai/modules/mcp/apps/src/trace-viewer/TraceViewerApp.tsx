/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * List/detail shell around the shared trace components. List rows are the
 * app's own RequestRow fed from log_traces summaries; the detail view (Task
 * 5) mounts the shared TraceDetail with fetchTrace bridged to log_trace.
 */
import type { App } from '@modelcontextprotocol/ext-apps';
import React, { useMemo, useState } from 'react';

import { RequestRow } from '@app-shared/components/trace/Trace';
import { EmptyState } from 'shell';

import { parseListPayload, type ListPayload } from './adapter';
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
};

export interface TraceViewerAppProps {
	app: App;
	initialResult: unknown;
}

export const TraceViewerApp: React.FC<TraceViewerAppProps> = ({ app, initialResult }) => {
	void app; // Task 5 wires callServerTool through this.
	const [selected, setSelected] = useState<number | null>(null);
	void selected; // Task 5 renders the detail view from this.

	const parsed = useMemo<{ list?: ListPayload; error?: string }>(() => {
		try {
			return { list: parseListPayload(parseToolJson(initialResult)) };
		} catch (err) {
			return { error: err instanceof ToolError ? err.message : String(err) };
		}
	}, [initialResult]);

	if (parsed.error) {
		return <div style={S.error}>{parsed.error}</div>;
	}
	const list = parsed.list as ListPayload;
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
