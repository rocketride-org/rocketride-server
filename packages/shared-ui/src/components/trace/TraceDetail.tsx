/**
 * @file TraceDetail — one request's full call tree, fetched via the log API
 * @license MIT
 *
 * The DetailPanel body for a single trace (request): given a trace id and a
 * fetch function (bound by the host to `session.getTrace`), it pulls the
 * trace's complete event set through the DVR reconstruction layer, folds it
 * into call rows, and renders the call tree with the Input/Output boxes —
 * the exact rendering that used to live inline under the Trace list rows.
 * Deliberately standalone so ANY surface can host it (the Trace pane's
 * DetailPanel today, the Analyze page tomorrow).
 */
import React, { useState, useMemo, useCallback, useEffect, CSSProperties } from 'react';
import { JsonTree } from './JsonTree';
import { renderTraceInput, renderTraceOutput, summaryTraceInput, renderTraceData } from './renderers';
import { traceDataEqual } from './renderers/utils';
import { renderFinalSections, resultFieldCount } from './renderers/render_final';
import type { TraceRow } from '../../modules/project/types';
import { parseServerEvent } from '../../modules/project/utils';
import { useTraceState } from '../../modules/project/hooks/useTraceState';
import { commonStyles } from '../../themes/styles';
import { EmptyState } from '../empty-state/EmptyState';
import { ToggleGroup } from '../toggle-group/ToggleGroup';

// =============================================================================
// INTERNAL TYPES
// =============================================================================

/**
 * One trace's reconstructed event set (the session.getTrace result shape).
 * The continuum stamps live in each event's BODY (body.eventTime +
 * body.logSeq) — the only place they exist.
 */
export interface ITraceFetchResult {
	events: Array<{ event: string; body: Record<string, unknown> & { eventTime: number; logSeq: number }; [key: string]: unknown }>;
}

/** Props for {@link TraceDetail}. */
export interface ITraceDetailProps {
	/** The trace's begin-event continuum seq — its permanent identity. */
	traceId: number;
	/** Pipeline project id (event parsing context). */
	projectId: string;
	/** Fetches the trace's complete event set (host binds session.getTrace). */
	fetchTrace: (traceId: number) => Promise<ITraceFetchResult>;
	/** Map of component id → display name from the pipeline definition. */
	componentNames?: Map<string, string> | undefined;
}

interface TraceTreeNode {
	row: TraceRow;
	children: TraceTreeNode[];
	parent: TraceTreeNode | null;
}

interface TraceObjectGroup {
	docId: number;
	objectName: string;
	nodes: TraceTreeNode[];
	hasError: boolean;
	inFlight: boolean;
	totalElapsed: number | null;
	resultData?: Record<string, unknown>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const LANE_COLORS: Record<string, string> = {
	open: 'var(--rr-chart-blue)',
	tags: 'var(--rr-chart-green)',
	text: 'var(--rr-chart-yellow)',
	documents: 'var(--rr-chart-purple)',
	closing: 'var(--rr-chart-orange)',
	close: 'var(--rr-chart-red)',
	data: 'var(--rr-chart-green)',
	video: 'var(--rr-chart-purple)',
	audio: 'var(--rr-chart-blue)',
	image: 'var(--rr-chart-orange)',
	table: 'var(--rr-chart-yellow)',
	invoke: 'var(--rr-chart-green)',
	questions: 'var(--rr-chart-purple)',
	answers: 'var(--rr-chart-green)',
};

const LANE_DISPLAY_NAMES: Record<string, string> = {
	tags: 'data',
	closing: 'flush',
};

function laneDisplayName(lane: string): string {
	return LANE_DISPLAY_NAMES[lane] || LANE_DISPLAY_NAMES[lane.toLowerCase()] || lane;
}

const BATCH_SIZE = 10;

// =============================================================================
// STYLES
// =============================================================================

const S = {
	// -- section wrapper --------------------------------------------------------
	section: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		overflow: 'hidden',
		color: 'var(--rr-text-primary)',
		fontFamily: 'var(--rr-font-family)',
		fontSize: 13,
	} as CSSProperties,

	// Flex column so treeScroll's flex sizing actually applies — as a plain
	// block, tall content was clipped by overflow:hidden instead of scrolling.
	content: {
		flex: 1,
		display: 'flex',
		flexDirection: 'column',
		minHeight: 0,
		overflow: 'hidden',
	} as CSSProperties,

	treeScroll: {
		flex: 1,
		overflowY: 'auto',
		overflowX: 'hidden',
		minWidth: 0,
	} as CSSProperties,

	// -- row (shared base) ------------------------------------------------------
	row: {
		display: 'flex',
		alignItems: 'center',
		padding: '3px 8px',
		cursor: 'pointer',
	} as CSSProperties,

	rowError: {
		backgroundColor: 'var(--rr-bg-widget-hover)',
	} as CSSProperties,

	rowHover: {
		backgroundColor: 'var(--rr-bg-list-hover)',
	} as CSSProperties,

	// -- object row -------------------------------------------------------------
	objectRow: {
		fontWeight: 600,
		backgroundColor: 'var(--rr-bg-surface-alt)',
	} as CSSProperties,

	objectRowInFlight: {
		fontWeight: 600,
		backgroundColor: 'var(--rr-bg-surface-alt)',
		opacity: 0.85,
	} as CSSProperties,

	// -- chevron ----------------------------------------------------------------
	chev: {
		width: 14,
		flexShrink: 0,
		textAlign: 'center',
		fontSize: 'inherit',
		color: 'var(--rr-text-secondary)',
		userSelect: 'none',
		cursor: 'pointer',
	} as CSSProperties,

	// -- name -------------------------------------------------------------------
	name: {
		flex: 1,
		minWidth: 0,
		...commonStyles.textEllipsis,
	} as CSSProperties,

	nameFile: {
		flex: 1,
		minWidth: 0,
		...commonStyles.textEllipsis,
		fontWeight: 700,
	} as CSSProperties,

	nameError: {
		flex: 1,
		minWidth: 0,
		...commonStyles.textEllipsis,
		color: 'var(--rr-color-error)',
	} as CSSProperties,

	// -- error icon -------------------------------------------------------------
	errIcon: {
		marginRight: 4,
		color: 'var(--rr-color-error)',
		fontSize: 12,
		flexShrink: 0,
	} as CSSProperties,

	// -- badge (lane label) -----------------------------------------------------
	badge: {
		display: 'inline-block',
		padding: '1px 6px',
		borderRadius: 3,
		fontSize: 10,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: '0.03em',
		lineHeight: '16px',
	} as CSSProperties,

	// -- in-flight badge --------------------------------------------------------
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

	// -- SSE narration row (node-authored progress messages) --------------------
	sseRow: {
		display: 'flex',
		alignItems: 'baseline',
		gap: 8,
		padding: '2px 8px 2px 22px',
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
	} as CSSProperties,

	sseTime: {
		flexShrink: 0,
		fontSize: 10,
		fontFamily: 'monospace',
		color: 'var(--rr-text-disabled)',
	} as CSSProperties,

	// -- time -------------------------------------------------------------------
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

	// -- data toggle / tree -----------------------------------------------------
	dpToggle: {
		cursor: 'pointer',
		fontWeight: 600,
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		userSelect: 'none',
		marginTop: 6,
		marginBottom: 4,
	} as CSSProperties,

	dpArr: {
		fontSize: 8,
		width: 12,
		textAlign: 'center',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	dpTree: {
		marginTop: 4,
		padding: 6,
		borderRadius: 4,
		backgroundColor: 'var(--rr-bg-paper)',
		overflow: 'auto',
		maxHeight: 300,
	} as CSSProperties,
} as const;

// =============================================================================
// HELPER: Badge style per lane (background tint derived from lane colour)
// =============================================================================

/** Map lane to explicit background tints (no color-mix — not supported in all webviews). */
const LANE_BG: Record<string, string> = {
	open: 'rgba(66,99,235,0.12)',
	tags: 'rgba(64,192,87,0.12)',
	data: 'rgba(64,192,87,0.12)',
	text: 'rgba(230,119,0,0.12)',
	documents: 'rgba(112,72,232,0.12)',
	closing: 'rgba(230,119,0,0.12)',
	close: 'rgba(201,42,42,0.12)',
	video: 'rgba(112,72,232,0.12)',
	audio: 'rgba(66,99,235,0.12)',
	image: 'rgba(230,119,0,0.12)',
	table: 'rgba(230,119,0,0.12)',
	invoke: 'rgba(64,192,87,0.12)',
	questions: 'rgba(112,72,232,0.12)',
	answers: 'rgba(64,192,87,0.12)',
};

function badgeStyle(lane: string): CSSProperties {
	const color = laneColor(lane);
	const bg = LANE_BG[lane] || LANE_BG[lane.toLowerCase()] || 'rgba(134,142,150,0.12)';
	return {
		...S.badge,
		color,
		backgroundColor: bg,
	};
}

// =============================================================================
// HELPER: Build tree from flat rows
// =============================================================================

function buildObjectGroups(rows: TraceRow[]): TraceObjectGroup[] {
	const grouped = new Map<number, TraceRow[]>();
	for (const row of rows) {
		let list = grouped.get(row.docId);
		if (!list) {
			list = [];
			grouped.set(row.docId, list);
		}
		list.push(row);
	}

	const groups: TraceObjectGroup[] = [];

	for (const [docId, docRows] of Array.from(grouped.entries())) {
		const rootNodes: TraceTreeNode[] = [];
		const stack: TraceTreeNode[] = [];
		let hasError = false;
		let resultData: Record<string, unknown> | undefined;

		for (const row of docRows) {
			if (row.error) hasError = true;

			// Extract result sentinel row — render separately, not in tree
			if (row.lane === '__result__') {
				resultData = row.pipelineResult;
				continue;
			}

			const node: TraceTreeNode = { row, children: [], parent: null };

			if (row.depth === 0) {
				rootNodes.push(node);
			} else if (row.depth > 0 && stack[row.depth - 1]) {
				node.parent = stack[row.depth - 1];
				stack[row.depth - 1].children.push(node);
			} else {
				// Orphan -- add to root
				rootNodes.push(node);
			}

			stack[row.depth] = node;
			// Trim deeper entries so stale parents don't linger
			stack.length = row.depth + 1;
		}

		// Compute total elapsed: last endTimestamp - first timestamp
		let totalElapsed: number | null = null;
		if (docRows.length > 0) {
			const first = docRows[0].timestamp;
			let lastEnd: number | undefined;
			for (let i = docRows.length - 1; i >= 0; i--) {
				if (docRows[i].endTimestamp) {
					lastEnd = docRows[i].endTimestamp;
					break;
				}
			}
			if (lastEnd) {
				totalElapsed = lastEnd - first;
			}
		}

		const objectName = docRows[0]?.objectName || '<unknown>';
		const inFlight = !docRows[0]?.completed;
		groups.push({
			docId,
			objectName,
			nodes: rootNodes,
			hasError,
			inFlight,
			totalElapsed,
			resultData,
		});
	}

	return groups;
}

// =============================================================================
// HELPER: Collect all parent node IDs (for expand-all)
// =============================================================================

function collectAllParentIds(nodes: TraceTreeNode[]): number[] {
	const ids: number[] = [];
	for (const node of nodes) {
		if (node.children.length > 0) {
			ids.push(node.row.id);
			ids.push(...collectAllParentIds(node.children));
		}
	}
	return ids;
}

// =============================================================================
// HELPER: Format elapsed time
// =============================================================================

function formatElapsed(ms: number | null | undefined): string {
	if (ms == null || ms < 0) return '\u2014';
	// One unit everywhere: seconds to two decimals \u2014 raw float millisecond
	// stamps must never reach the screen.
	return `${(ms / 1000).toFixed(2)}s`;
}

/** Count total nodes in a tree (including the roots themselves). */
function countAllNodes(nodes: TraceTreeNode[]): number {
	let count = 0;
	for (const n of nodes) {
		count += 1 + countAllNodes(n.children);
	}
	return count;
}

function getRowElapsed(row: TraceRow): number | null {
	if (row.endTimestamp && row.timestamp) {
		return row.endTimestamp - row.timestamp;
	}
	return null;
}

// =============================================================================
// HELPER: Lane color
// =============================================================================

function laneColor(lane: string): string {
	return LANE_COLORS[lane] || LANE_COLORS[lane.toLowerCase()] || 'var(--rr-text-secondary)';
}

/** Resolve a component ID to its display name via the pipeline lookup map.
 *  Falls back to stripping the trailing _N instance suffix. */
function resolveDisplayName(filterName: string, componentNames?: Map<string, string>): string {
	if (componentNames) {
		// Try exact match first (e.g. "parse_1" mapped directly)
		const exact = componentNames.get(filterName);
		if (exact) return exact;
	}
	// Fallback: strip trailing _N instance suffix
	return filterName.replace(/_\d+$/, '');
}

// =============================================================================
// STYLES: Collapsed/Expanded call tree
// =============================================================================

const SN = {
	nest: {
		marginLeft: 20,
		borderLeft: '1px solid var(--rr-border)',
	} as CSSProperties,
	collapsedRow: {
		display: 'flex',
		alignItems: 'center',
		padding: '3px 8px',
		cursor: 'pointer',
		gap: 3,
		minHeight: 26,
	} as CSSProperties,
	expandedHeader: {
		display: 'flex',
		alignItems: 'center',
		padding: '3px 8px',
		cursor: 'pointer',
		gap: 3,
		minHeight: 26,
		background: 'var(--rr-bg-surface-alt)',
	} as CSSProperties,
	summary: {
		flex: 1,
		color: 'var(--rr-text-secondary)',
		fontWeight: 400,
		fontSize: 11,
		fontStyle: 'italic' as const,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap' as const,
		marginLeft: 4,
	} as CSSProperties,
	moreRow: {
		padding: '3px 8px 3px 26px',
		cursor: 'pointer',
		color: 'var(--rr-chart-blue)',
		fontSize: 11,
		fontStyle: 'italic' as const,
	} as CSSProperties,
};

// =============================================================================
// SUB-COMPONENT: Collapsible call-tree node
// =============================================================================

/** Build a short summary of trace data for display in the row. */
function dataSummary(data: Record<string, unknown> | undefined | null): string {
	if (!data) return '';
	const keys = Object.keys(data);
	if (!keys.length) return '';
	const maxLen = 70;
	const parts = keys.slice(0, 3).map((k) => {
		const v = data[k];
		if (v === null) return `${k}: null`;
		if (typeof v === 'string') return `${k}: "${v.length > 20 ? v.slice(0, 20) + '\u2026' : v}"`;
		if (typeof v === 'number') return `${k}: ${v}`;
		if (typeof v === 'object') return `${k}: {\u2026}`;
		return `${k}: ${String(v)}`;
	});
	const result = parts.join(', ');
	return result.length > maxLen ? result.slice(0, maxLen) + '\u2026' : result;
}

interface TraceCallNodeProps {
	node: TraceTreeNode;
	componentNames?: Map<string, string>;
	expandedNodes: Set<number>;
	moreRevealed: Map<string, number>;
	onToggleExpand: (id: number) => void;
	onExpandAll: (node: TraceTreeNode) => void;
	onCollapseAll: (node: TraceTreeNode) => void;
	onRevealMore: (key: string) => void;
}

const TraceCallNode: React.FC<TraceCallNodeProps> = ({ node, componentNames, expandedNodes, moreRevealed, onToggleExpand, onExpandAll, onCollapseAll, onRevealMore }) => {
	const { row } = node;
	const isExpanded = expandedNodes.has(row.id);
	const isError = !!row.error;
	const isEmpty = node.children.length === 0 && !row.entryData && !row.exitData && !row.error;
	const elapsed = getRowElapsed(row);
	const summary = summaryTraceInput(row.entryData, row.lane) || summaryTraceInput(row.exitData, row.lane) || dataSummary(row.entryData) || dataSummary(row.exitData) || '';
	const name = resolveDisplayName(row.filterName, componentNames);
	const childCount = countAllNodes(node.children);

	const nameStyle: CSSProperties = isError ? S.nameError : isEmpty ? { ...S.name, flex: 'none', color: 'var(--rr-text-disabled)' } : { ...S.name, flex: 'none' };

	const handleClick = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (e.ctrlKey || e.metaKey || e.shiftKey) {
			if (isExpanded) onCollapseAll(node);
			else onExpandAll(node);
		} else {
			onToggleExpand(row.id);
		}
	};

	if (!isExpanded) {
		// ── COLLAPSED: single row with ▸ ──
		return (
			<div style={{ ...SN.collapsedRow, ...(isError ? S.rowError : {}) }} onClick={handleClick} title="Click to expand (Shift/Ctrl-Click to expand all)">
				<span style={S.chev}>{'\u25B8'}</span>
				{isError && <span style={S.errIcon}>{'\u2716'}</span>}
				<span style={nameStyle}>{name}</span>
				<span style={isEmpty ? { ...badgeStyle(row.lane), opacity: 0.5 } : badgeStyle(row.lane)}>{laneDisplayName(row.lane)}</span>
				{summary && <span style={SN.summary}>{summary}</span>}
				<span style={{ flex: 1 }} />
				{childCount > 0 && <span style={{ fontSize: 10, color: 'var(--rr-text-disabled)', marginRight: 4 }}>({childCount} calls)</span>}
				{isError ? <span style={S.timeError}>ERROR</span> : <span style={isEmpty ? { ...S.timeCol, color: 'var(--rr-text-disabled)' } : S.timeCol}>{formatElapsed(elapsed)}</span>}
			</div>
		);
	}

	// ── EXPANDED: ▾ header → Input box → children → Output box ──
	return (
		<div>
			{/* ▾ Header */}
			<div style={SN.expandedHeader} onClick={handleClick} title="Click to collapse (Shift/Ctrl-Click to collapse all)">
				<span style={S.chev}>{'\u25BE'}</span>
				{isError && <span style={S.errIcon}>{'\u2716'}</span>}
				<span style={nameStyle}>{name}</span>
				<span style={badgeStyle(row.lane)}>{laneDisplayName(row.lane)}</span>
				<span style={{ flex: 1 }} />
				{childCount > 0 && <span style={{ fontSize: 10, color: 'var(--rr-text-disabled)', marginRight: 4 }}>({childCount} calls)</span>}
				{isError ? <span style={S.timeError}>ERROR</span> : <span style={S.timeCol}>{formatElapsed(elapsed)}</span>}
			</div>

			<div style={SN.nest}>
				{/* Data boxes — single "Data" when identical, split Input/Output when different */}
				{(() => {
					const outputData = row.error ? { error: row.error } : row.exitData;
					const hasOutput = !!(row.exitData || row.error || row.result);
					const identical = hasOutput && traceDataEqual(row.entryData, outputData);

					return (
						<>
							<InputDataBox node={node} data={row.entryData} label={identical || !hasOutput ? 'Data' : 'Input'} lane={row.lane} componentNames={componentNames} showCallInfo />

							{/* Children */}
							{node.children.length > 0 && (
								<div style={{ margin: '10px 0' }}>
									<TraceCallChildren nodes={node.children} componentNames={componentNames} expandedNodes={expandedNodes} moreRevealed={moreRevealed} onToggleExpand={onToggleExpand} onExpandAll={onExpandAll} onCollapseAll={onCollapseAll} onRevealMore={onRevealMore} />
								</div>
							)}

							{/* Output box — only when data differs */}
							{hasOutput && !identical && <OutputDataBox node={node} data={outputData} inputData={row.entryData} lane={row.lane} componentNames={componentNames} defaultExpanded={row.depth === 0} />}

							{/* Result footer — always shown when there's a result */}
							{(row.result || row.error) && <ResultFooter result={row.result} error={row.error} />}
						</>
					);
				})()}
			</div>
		</div>
	);
};

/** Data view mode toggle buttons and renderer. */
type DataViewMode = 'tree' | 'json' | 'raw';

const VIEW_MODES: { mode: DataViewMode; label: string }[] = [
	{ mode: 'tree', label: 'Data' },
	{ mode: 'json', label: 'JSON' },
	{ mode: 'raw', label: 'Raw' },
];

const DataViewToggle: React.FC<{ mode: DataViewMode; modes: typeof VIEW_MODES; onChange: (m: DataViewMode) => void }> = ({ mode, modes, onChange }) => (
	<span style={{ marginLeft: 'auto' }}>
		<ToggleGroup options={modes.map((v) => ({ id: v.mode, label: v.label }))} value={mode} onChange={onChange} />
	</span>
);

// =============================================================================
// SHARED BOX STYLES
// =============================================================================

const boxStyle: CSSProperties = {
	background: 'var(--rr-bg-widget)',
	borderRadius: '0 4px 4px 0',
	padding: '6px 10px',
	margin: '2px 0 4px',
	fontSize: 12,
};

const kvStyle: CSSProperties = { display: 'flex', gap: 8, fontSize: 11, lineHeight: '16px' };
const kStyle: CSSProperties = { color: 'var(--rr-text-secondary)', flexShrink: 0, minWidth: 60 };
const vStyle: CSSProperties = { color: 'var(--rr-text-primary)' };

// =============================================================================
// INPUT DATA BOX
// =============================================================================

const InputDataBox: React.FC<{
	node: TraceTreeNode;
	data: unknown;
	label?: string;
	lane: string;
	componentNames?: Map<string, string>;
	showCallInfo?: boolean;
}> = ({ node, data, label = 'Input', lane, componentNames, showCallInfo }) => {
	const hasTreeView = data != null && renderTraceData(data, lane) != null;
	const availableModes = hasTreeView ? VIEW_MODES : VIEW_MODES.filter((v) => v.mode !== 'tree');
	const [expanded, setExpanded] = useState(true);
	const [viewMode, setViewMode] = useState<DataViewMode>(() => (hasTreeView ? 'tree' : 'json'));

	const { row } = node;
	const elapsed = getRowElapsed(row);
	const parentElapsed = node.parent ? getRowElapsed(node.parent.row) : null;
	const pctOfParent = elapsed != null && parentElapsed != null && parentElapsed > 0 ? Math.round((elapsed / parentElapsed) * 100) : null;

	// Build call chain
	const chainParts: string[] = [];
	if (showCallInfo) {
		let p: TraceTreeNode | null = node;
		while (p) {
			chainParts.unshift(resolveDisplayName(p.row.filterName, componentNames));
			p = p.parent;
		}
	}

	return (
		<div style={boxStyle}>
			{showCallInfo && (
				<div style={{ marginBottom: 6 }}>
					{elapsed != null && (
						<div style={kvStyle}>
							<span style={kStyle}>Elapsed</span>
							<span style={{ ...vStyle, fontWeight: 600, fontFamily: 'monospace', color: 'var(--rr-brand)' }}>{formatElapsed(elapsed)}</span>
							{pctOfParent != null && (
								<span style={{ color: 'var(--rr-text-secondary)', marginLeft: 6, fontSize: 10 }}>
									({pctOfParent}% of {node.parent ? resolveDisplayName(node.parent.row.filterName, componentNames) : ''})
								</span>
							)}
						</div>
					)}
					{chainParts.length > 1 && (
						<div style={{ ...kvStyle, marginTop: 4, paddingTop: 4 }}>
							<span style={kStyle}>Chain</span>
							<span style={{ ...vStyle, display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
								{chainParts.map((cname, i) => (
									<React.Fragment key={i}>
										{i > 0 && <span style={{ color: 'var(--rr-text-secondary)', fontSize: 10 }}>{'\u2192'}</span>}
										<span style={{ padding: '0 4px', borderRadius: 3, backgroundColor: 'var(--rr-bg-surface-alt)', fontSize: 11, fontWeight: 500 }}>{cname}</span>
									</React.Fragment>
								))}
							</span>
						</div>
					)}
				</div>
			)}

			{data != null && (
				<>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<div style={S.dpToggle} onClick={() => setExpanded(!expanded)}>
							<span style={S.dpArr}>{expanded ? '\u25BE' : '\u25B8'}</span>
							{label}
						</div>
						{expanded && <DataViewToggle mode={viewMode} modes={availableModes} onChange={setViewMode} />}
					</div>
					{expanded && (
						<div style={{ padding: '0 8px' }}>
							{viewMode === 'tree' ? (
								renderTraceInput(data, lane)
							) : viewMode === 'json' ? (
								<div style={S.dpTree}>
									<JsonTree data={data} defaultExpanded={2} />
								</div>
							) : (
								<pre style={{ ...S.dpTree, fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(data)}</pre>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
};

// =============================================================================
// OUTPUT DATA BOX
// =============================================================================

const OutputDataBox: React.FC<{
	node: TraceTreeNode;
	data: unknown;
	inputData: unknown;
	lane: string;
	componentNames?: Map<string, string>;
	/** Open on first render (top-level calls in the detail panel). */
	defaultExpanded?: boolean;
}> = ({ node, data, inputData, lane, defaultExpanded }) => {
	const hasTreeView = data != null && renderTraceOutput(data, lane, inputData) != null;
	const availableModes = hasTreeView ? VIEW_MODES : VIEW_MODES.filter((v) => v.mode !== 'tree');
	const [expanded, setExpanded] = useState(defaultExpanded ?? false);
	const [viewMode, setViewMode] = useState<DataViewMode>(() => (hasTreeView ? 'tree' : 'json'));

	const { row } = node;
	const resultText = row.result || null;

	return (
		<div style={boxStyle}>
			{/* Result info when expanded */}
			{expanded && resultText && (
				<div style={{ ...kvStyle, marginBottom: 6 }}>
					<span style={kStyle}>Result</span>
					<span style={vStyle}>{resultText}</span>
				</div>
			)}

			{data != null ? (
				<>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<div style={S.dpToggle} onClick={() => setExpanded(!expanded)}>
							<span style={S.dpArr}>{expanded ? '\u25BE' : '\u25B8'}</span>
							Output
						</div>
						{!expanded && resultText && (
							<span style={{ fontSize: 11, color: 'var(--rr-text-secondary)', fontStyle: 'italic' }}>
								{'\u2014'} {resultText}
							</span>
						)}
						{expanded && <DataViewToggle mode={viewMode} modes={availableModes} onChange={setViewMode} />}
					</div>
					{expanded && (
						<div style={{ padding: '0 8px' }}>
							{viewMode === 'tree' ? (
								renderTraceOutput(data, lane, inputData)
							) : viewMode === 'json' ? (
								<div style={S.dpTree}>
									<JsonTree data={data} defaultExpanded={2} />
								</div>
							) : (
								<pre style={{ ...S.dpTree, fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(data)}</pre>
							)}
						</div>
					)}
				</>
			) : resultText ? (
				<div style={{ fontSize: 11, color: 'var(--rr-text-secondary)' }}>
					Output {'\u2014'} {resultText}
				</div>
			) : null}
		</div>
	);
};

// =============================================================================
// RESULT FOOTER — small box at the bottom showing the call's result status
// =============================================================================

const ResultFooter: React.FC<{ result?: string; error?: string }> = ({ result, error }) => {
	const footerStyle: CSSProperties = {
		...boxStyle,
		marginTop: -4, // butt against the box above
		padding: '4px 10px',
		fontSize: 11,
		display: 'flex',
		alignItems: 'center',
		gap: 6,
	};

	if (error || result === 'error') {
		return (
			<div style={{ ...footerStyle, color: 'var(--rr-color-error)' }}>
				<span style={{ fontWeight: 600 }}>Error</span>
				{error && <span style={{ color: 'var(--rr-text-primary)' }}>{error}</span>}
			</div>
		);
	}

	if (result === 'skip') {
		return (
			<div style={{ ...footerStyle, color: 'var(--rr-color-warning)' }}>
				<span style={{ fontWeight: 600 }}>Skip</span>
				<span style={{ color: 'var(--rr-text-secondary)' }}>child calls will be skipped</span>
			</div>
		);
	}

	if (result === 'preventDefault') {
		return (
			<div style={{ ...footerStyle, color: 'var(--rr-color-warning)' }}>
				<span style={{ fontWeight: 600 }}>Prevent Default</span>
				<span style={{ color: 'var(--rr-text-secondary)' }}>default action prevented</span>
			</div>
		);
	}

	// Default: continue / OK
	return (
		<div style={{ ...footerStyle, color: 'var(--rr-color-success)' }}>
			<span style={{ fontWeight: 600 }}>OK</span>
			{result && result !== 'continue' && <span style={{ color: 'var(--rr-text-secondary)' }}>{result}</span>}
		</div>
	);
};

/** Renders a list of children with batching for identical consecutive siblings. */
const TraceCallChildren: React.FC<Omit<TraceCallNodeProps, 'node'> & { nodes: TraceTreeNode[] }> = ({ nodes, componentNames, expandedNodes, moreRevealed, onToggleExpand, onExpandAll, onCollapseAll, onRevealMore }) => {
	const items: React.ReactNode[] = [];
	let i = 0;
	while (i < nodes.length) {
		const child = nodes[i];
		// Batch detection
		let runEnd = i + 1;
		while (runEnd < nodes.length && nodes[runEnd].row.filterName === child.row.filterName && nodes[runEnd].row.lane === child.row.lane && nodes[runEnd].children.length === 0 && child.children.length === 0) {
			runEnd++;
		}
		const runLen = runEnd - i;
		if (runLen > BATCH_SIZE) {
			const batchKey = String(child.row.id);
			const revealed = moreRevealed.get(batchKey) ?? 0;
			const showCount = Math.min(BATCH_SIZE + revealed * BATCH_SIZE, runLen);
			for (let j = i; j < i + showCount; j++) {
				items.push(<TraceCallNode key={nodes[j].row.id} node={nodes[j]} componentNames={componentNames} expandedNodes={expandedNodes} moreRevealed={moreRevealed} onToggleExpand={onToggleExpand} onExpandAll={onExpandAll} onCollapseAll={onCollapseAll} onRevealMore={onRevealMore} />);
			}
			const remaining = runLen - showCount;
			if (remaining > 0) {
				items.push(
					<div key={`more-${batchKey}`} style={SN.moreRow} onClick={() => onRevealMore(batchKey)}>
						{remaining} more... (click to show next {Math.min(BATCH_SIZE, remaining)})
					</div>
				);
			}
			i = runEnd;
		} else {
			items.push(<TraceCallNode key={nodes[i].row.id} node={nodes[i]} componentNames={componentNames} expandedNodes={expandedNodes} moreRevealed={moreRevealed} onToggleExpand={onToggleExpand} onExpandAll={onExpandAll} onCollapseAll={onCollapseAll} onRevealMore={onRevealMore} />);
			i++;
		}
	}
	return <>{items}</>;
};

// =============================================================================
// SUB-COMPONENT: Collapsible result row (shown after the call tree)
// =============================================================================

const ResultRow: React.FC<{ resultData: Record<string, unknown> }> = ({ resultData }) => {
	const [expanded, setExpanded] = useState(false);
	const [hovered, setHovered] = useState(false);
	const count = resultFieldCount(resultData);

	const headerStyle: CSSProperties = {
		...(expanded ? SN.expandedHeader : SN.collapsedRow),
		...(hovered && !expanded ? S.rowHover : {}),
	};

	return (
		<div>
			<div style={headerStyle} onClick={() => setExpanded((v) => !v)} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
				<span style={S.chev}>{expanded ? '\u25BE' : '\u25B8'}</span>
				<span style={{ ...S.name, flex: 'none', color: 'var(--rr-color-success)', fontWeight: 600 }}>Result</span>
				{!expanded && count > 0 && (
					<span style={{ fontSize: 10, color: 'var(--rr-text-disabled)', marginLeft: 6 }}>
						({count} field{count !== 1 ? 's' : ''})
					</span>
				)}
			</div>
			{expanded && <div style={SN.nest}>{renderFinalSections(resultData)}</div>}
		</div>
	);
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

/**
 * Fetch one trace through the log API and render its complete call tree.
 */
export const TraceDetail: React.FC<ITraceDetailProps> = ({ traceId, projectId, fetchTrace, componentNames }) => {
	const [expandedNodes, setExpandedNodes] = useState<Set<number>>(new Set());
	const [moreRevealed, setMoreRevealed] = useState<Map<string, number>>(new Map());
	const [fetched, setFetched] = useState<ITraceFetchResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Fetch the trace's reconstructed events whenever the id changes (the
	// cancelled flag keeps a stale response from landing on a newer id).
	useEffect(() => {
		let cancelled = false;
		setFetched(null);
		setError(null);
		fetchTrace(traceId)
			.then((result) => {
				if (!cancelled) setFetched(result);
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [traceId, fetchTrace]);

	// Fold the raw flow events into call rows (same parse as the live view).
	const foldedEvents = useMemo(() => {
		const folded: NonNullable<ReturnType<typeof parseServerEvent>['traceEvent']>[] = [];
		for (const message of fetched?.events ?? []) {
			const parsed = parseServerEvent(message as unknown as Parameters<typeof parseServerEvent>[0], projectId);
			if (parsed.traceEvent) folded.push(parsed.traceEvent);
		}
		return folded;
	}, [fetched, projectId]);
	const { rows } = useTraceState(foldedEvents, traceId);

	// getTrace is keyed by begin seq, so the fetched events are exactly ONE
	// request's begin..end window — the fold yields a single group.
	const group = useMemo(() => {
		const groups = buildObjectGroups(rows);
		return groups[0] ?? null;
	}, [rows]);

	// The node's own narration (SSE messages on this trace's slot),
	// timestamped for interleaving with the call rows.
	const sseEvents = useMemo(() => (fetched?.events ?? []).filter((ev) => ev.event === 'apaevt_sse'), [fetched]);

	// The panel opens READABLE: the top-level calls arrive expanded (their
	// Input/Output boxes open with them); nested calls stay collapsed.
	useEffect(() => {
		setExpandedNodes(new Set((group?.nodes ?? []).map((node) => node.row.id)));
		setMoreRevealed(new Map());
	}, [traceId, group]);

	const toggleNode = useCallback((id: number) => {
		setExpandedNodes((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const expandAllForNode = useCallback((node: TraceTreeNode) => {
		const allIds = collectAllParentIds(node.children);
		setExpandedNodes((prev) => {
			const next = new Set(prev);
			next.add(node.row.id);
			for (const id of allIds) next.add(id);
			return next;
		});
	}, []);

	const collapseAllForNode = useCallback((node: TraceTreeNode) => {
		const allIds = collectAllParentIds(node.children);
		setExpandedNodes((prev) => {
			const next = new Set(prev);
			next.delete(node.row.id);
			for (const id of allIds) next.delete(id);
			return next;
		});
	}, []);

	const revealMore = useCallback((groupKey: string) => {
		setMoreRevealed((prev) => {
			const next = new Map(prev);
			next.set(groupKey, (next.get(groupKey) ?? 0) + 1);
			return next;
		});
	}, []);

	if (error) {
		return <EmptyState title="Trace unavailable" description={error} />;
	}
	if (fetched === null) {
		return <div style={{ padding: 16, fontSize: 12.5, color: 'var(--rr-text-secondary)' }}>Loading trace{'\u2026'}</div>;
	}
	if (!group) {
		return <EmptyState title="No trace data" description="This request has no recorded calls at the current position." />;
	}

	// Interleave narration with the TOP-LEVEL call rows by time: SSE
	// messages appear between the calls they happened around, without
	// disturbing the nested batching inside each call.
	const interleaved: React.ReactNode[] = [];
	{
		let nodeIdx = 0;
		let sseIdx = 0;
		let run: typeof group.nodes = [];
		const flushRun = () => {
			if (run.length === 0) return;
			interleaved.push(
				<TraceCallChildren key={`run-${run[0]?.row.id}`} nodes={run} componentNames={componentNames} expandedNodes={expandedNodes} moreRevealed={moreRevealed} onToggleExpand={toggleNode} onExpandAll={expandAllForNode} onCollapseAll={collapseAllForNode} onRevealMore={revealMore} />,
			);
			run = [];
		};
		while (nodeIdx < group.nodes.length || sseIdx < sseEvents.length) {
			const node = group.nodes[nodeIdx];
			const sse = sseEvents[sseIdx];
			const nodeMs = node ? node.row.timestamp : Number.POSITIVE_INFINITY;
			const sseMs = sse ? sse.body.eventTime * 1000 : Number.POSITIVE_INFINITY;
			if (sseMs < nodeMs) {
				flushRun();
				const body = (sse.body ?? {}) as Record<string, unknown>;
				const text = typeof body.message === 'string' && body.message ? body.message : JSON.stringify(body.data ?? body);
				interleaved.push(
					<div key={`sse-${sse.body.logSeq}`} style={S.sseRow}>
						<span style={S.sseTime}>{new Date(sseMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
						{text}
					</div>,
				);
				sseIdx += 1;
			} else {
				run.push(node);
				nodeIdx += 1;
			}
		}
		flushRun();
	}

	return (
		<section style={S.section}>
			<div style={S.content}>
				<div style={S.treeScroll}>
					{interleaved}
					{group.resultData && <ResultRow resultData={group.resultData} />}
				</div>
			</div>
		</section>
	);
};

export default TraceDetail;
