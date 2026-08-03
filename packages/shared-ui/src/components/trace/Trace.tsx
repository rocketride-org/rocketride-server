/**
 * @file Trace — the request list of a source's trace view
 * @license MIT
 *
 * One row per request (document/trace): name, begin date/time, call count,
 * elapsed. Clicking a row opens the request's full call tree in the stock
 * DetailPanel (hosted by the section) via {@link TraceProps.onOpenTrace} —
 * the tree itself renders in {@link TraceDetail}, fed by the log API's
 * getTrace. The list deliberately does NOT expand inline: payload
 * inspection always gets the panel's full real estate.
 */
import React, { CSSProperties, useMemo, useState } from 'react';
import type { TraceRow } from '../../modules/project/types';
import { commonStyles } from 'shell';
import { EmptyState } from 'shell';

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link Trace}. */
export interface TraceProps {
	rows: TraceRow[];
	/** Map of component id → display name from the pipeline definition. */
	componentNames?: Map<string, string>;
	/** Opens a request's call tree in the host's DetailPanel. The id is the
	    trace's begin-event continuum seq — its permanent identity (what the
	    log API's getTrace resolves). */
	onOpenTrace?: (traceBeginSeq: number, objectName: string) => void;
}

/** One request's list-row summary, folded from its rows. */
interface TraceRequestSummary {
	docId: number;
	/** Begin-event continuum seq — the permanent identity getTrace resolves. */
	beginSeq: number | null;
	objectName: string;
	hasError: boolean;
	inFlight: boolean;
	/** Begin → last recorded end (ms), null while nothing has closed. */
	totalElapsed: number | null;
	/** When the request began (epoch ms). */
	beginTimestamp: number | null;
	/** Number of recorded calls (tree nodes). */
	totalCalls: number;
}

// =============================================================================
// STYLES
// =============================================================================

const S = {
	section: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		overflow: 'hidden',
		color: 'var(--rr-text-primary)',
		fontFamily: 'var(--rr-font-family)',
		fontSize: 13,
	} as CSSProperties,

	list: {
		flex: 1,
		overflowY: 'auto',
		overflowX: 'hidden',
		minWidth: 0,
	} as CSSProperties,

	row: {
		display: 'flex',
		alignItems: 'center',
		padding: '5px 10px',
		cursor: 'pointer',
		fontWeight: 600,
		backgroundColor: 'var(--rr-bg-surface-alt)',
		borderBottom: '1px solid var(--rr-bg-widget)',
	} as CSSProperties,

	rowInFlight: {
		opacity: 0.85,
	} as CSSProperties,

	rowHover: {
		backgroundColor: 'var(--rr-bg-list-hover)',
	} as CSSProperties,

	name: {
		flex: 1,
		minWidth: 0,
		...commonStyles.textEllipsis,
		fontWeight: 700,
	} as CSSProperties,

	inFlightBadge: {
		display: 'inline-block',
		padding: '1px 6px',
		borderRadius: 3,
		fontSize: 10,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: '0.03em',
		lineHeight: '16px',
		color: 'var(--rr-chart-blue)',
		backgroundColor: 'var(--rr-bg-widget-hover)',
	} as CSSProperties,

	// Request begin date/time — the DVR spans days, so the date matters.
	beginStamp: {
		flexShrink: 0,
		marginRight: 10,
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		fontFamily: 'monospace',
	} as CSSProperties,

	calls: {
		fontSize: 10,
		color: 'var(--rr-text-disabled)',
		marginRight: 4,
		flexShrink: 0,
	} as CSSProperties,

	timeCol: {
		width: 64,
		flexShrink: 0,
		textAlign: 'right',
		paddingRight: 8,
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		fontFamily: 'monospace',
	} as CSSProperties,

	timeError: {
		width: 64,
		flexShrink: 0,
		textAlign: 'right',
		paddingRight: 8,
		fontSize: 11,
		fontFamily: 'monospace',
		color: 'var(--rr-color-error)',
		fontWeight: 600,
	} as CSSProperties,
} as const;

// =============================================================================
// HELPERS
// =============================================================================

/** One display unit everywhere: seconds to two decimals. */
function formatElapsed(ms: number | null): string {
	if (ms == null || ms < 0) return '—';
	return `${(ms / 1000).toFixed(2)}s`;
}

/** Compact begin date + time (epoch ms). */
function formatBeginStamp(ms: number): string {
	return new Date(ms).toLocaleString([], {
		month: 'numeric',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});
}

/**
 * Fold the flat rows into one summary per request (document), preserving
 * first-seen order — the same grouping the call-tree view uses, minus the
 * tree itself (the DetailPanel builds that from the log API).
 */
function buildRequestSummaries(rows: TraceRow[]): TraceRequestSummary[] {
	const byDoc = new Map<number, TraceRow[]>();
	for (const row of rows) {
		const bucket = byDoc.get(row.docId);
		if (bucket) bucket.push(row);
		else byDoc.set(row.docId, [row]);
	}

	const summaries: TraceRequestSummary[] = [];
	for (const [docId, docRows] of Array.from(byDoc.entries())) {
		// Total elapsed: last recorded end - first begin (open = null).
		let lastEnd: number | undefined;
		for (let i = docRows.length - 1; i >= 0; i--) {
			if (docRows[i].endTimestamp) {
				lastEnd = docRows[i].endTimestamp;
				break;
			}
		}
		summaries.push({
			docId,
			beginSeq: docRows[0]?.beginSeq ?? null,
			objectName: docRows[0]?.objectName || '<unknown>',
			hasError: docRows.some((row) => !!row.error),
			inFlight: !docRows[0]?.completed,
			totalElapsed: lastEnd !== undefined ? lastEnd - docRows[0].timestamp : null,
			beginTimestamp: docRows[0]?.timestamp ?? null,
			totalCalls: docRows.filter((row) => row.lane !== '__result__').length,
		});
	}
	return summaries;
}

// =============================================================================
// SUB-COMPONENT: Request row
// =============================================================================

const RequestRow: React.FC<{ summary: TraceRequestSummary; onOpen?: (() => void) | undefined }> = ({ summary, onOpen }) => {
	const [hovered, setHovered] = useState(false);

	const timeDisplay = summary.hasError ? <span style={S.timeError}>ERROR</span> : <span style={S.timeCol}>{formatElapsed(summary.totalElapsed)}</span>;
	const rowStyle: CSSProperties = {
		...S.row,
		...(summary.inFlight ? S.rowInFlight : {}),
		...(hovered ? S.rowHover : {}),
	};

	return (
		<div style={rowStyle} onClick={onOpen} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} title="Click to inspect this request">
			<span style={S.name}>{summary.objectName}</span>
			{summary.inFlight && <span style={S.inFlightBadge}>processing</span>}
			<span style={{ flex: 1 }} />
			{summary.beginTimestamp !== null && <span style={S.beginStamp}>{formatBeginStamp(summary.beginTimestamp)}</span>}
			{summary.totalCalls > 0 && <span style={S.calls}>({summary.totalCalls} calls)</span>}
			{timeDisplay}
		</div>
	);
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

const Trace: React.FC<TraceProps> = ({ rows, onOpenTrace }) => {
	const summaries = useMemo(() => buildRequestSummaries(rows), [rows]);

	if (summaries.length === 0) {
		return <EmptyState title="No trace data" description="Component calls appear here while the pipeline runs or when replaying a recorded run." />;
	}

	return (
		<section style={S.section}>
			<div style={S.list}>
				{summaries.map((summary) => (
					<RequestRow key={summary.docId} summary={summary} onOpen={onOpenTrace && summary.beginSeq !== null ? () => onOpenTrace(summary.beginSeq as number, summary.objectName) : undefined} />
				))}
			</div>
		</section>
	);
};

export default Trace;
