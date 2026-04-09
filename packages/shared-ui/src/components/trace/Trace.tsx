/**
 * @file Trace — pipeline call-tree viewer with detail panel
 * @license MIT
 *
 * Ported from apps/vscode TraceSection/TraceSection.tsx.
 * All styles are inline CSSProperties objects; no external CSS files.
 * Colour tokens use the --rr-* namespace.
 */
import React, { useState, useMemo, useCallback, CSSProperties } from 'react';
import { JsonTree } from './JsonTree';
import { renderTraceData, summaryTraceData } from './renderers';
import type { TraceRow } from '../../modules/project/types';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// INTERNAL TYPES
// =============================================================================

interface TraceProps {
	rows: TraceRow[];
	onClear: () => void;
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
		fontFamily: 'var(--rr-font-sans, sans-serif)',
		fontSize: 13,
	} as CSSProperties,

	header: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '6px 12px',
		fontWeight: 600,
		fontSize: 13,
		borderBottom: '1px solid var(--rr-border-default)',
		flexShrink: 0,
	} as CSSProperties,

	controls: {
		display: 'flex',
		gap: 6,
	} as CSSProperties,

	clearBtn: {
		...commonStyles.buttonSecondary,
		padding: '2px 8px',
		fontSize: 12,
		borderRadius: 3,
	} as CSSProperties,

	content: {
		flex: 1,
		overflow: 'hidden',
	} as CSSProperties,

	noData: {
		...commonStyles.empty,
		fontStyle: 'italic',
	} as CSSProperties,

	// -- layout -----------------------------------------------------------------
	layout: {
		display: 'flex',
		height: '100%',
		overflow: 'hidden',
	} as CSSProperties,

	treeScroll: {
		flex: 1,
		overflowY: 'auto',
		overflowX: 'hidden',
		minWidth: 0,
	} as CSSProperties,

	// -- tree header ------------------------------------------------------------
	treeHdr: {
		display: 'flex',
		alignItems: 'center',
		padding: '4px 8px 4px 28px',
		fontSize: 11,
		fontWeight: 600,
		color: 'var(--rr-text-secondary)',
		textTransform: 'uppercase',
		letterSpacing: '0.04em',
		borderBottom: '1px solid var(--rr-border-default)',
		flexShrink: 0,
	} as CSSProperties,

	colCall: {
		flex: 1,
		minWidth: 0,
	} as CSSProperties,

	colLane: {
		width: 80,
		flexShrink: 0,
		textAlign: 'center',
	} as CSSProperties,

	colTime: {
		width: 64,
		flexShrink: 0,
		textAlign: 'right',
		paddingRight: 8,
	} as CSSProperties,

	// -- row (shared base) ------------------------------------------------------
	row: {
		display: 'flex',
		alignItems: 'center',
		padding: '3px 8px',
		cursor: 'pointer',
		borderBottom: '1px solid var(--rr-border-subtle)',
	} as CSSProperties,

	rowSelected: {
		backgroundColor: 'var(--rr-bg-active)',
	} as CSSProperties,

	rowError: {
		backgroundColor: 'var(--rr-bg-error)',
	} as CSSProperties,

	rowHover: {
		// applied via onMouseEnter/Leave
		backgroundColor: 'var(--rr-bg-hover)',
	} as CSSProperties,

	// -- object row -------------------------------------------------------------
	objectRow: {
		fontWeight: 600,
		backgroundColor: 'var(--rr-bg-surface)',
	} as CSSProperties,

	objectRowInFlight: {
		fontWeight: 600,
		backgroundColor: 'var(--rr-bg-surface)',
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

	// -- dot (lane colour) ------------------------------------------------------
	dot: {
		width: 8,
		height: 8,
		borderRadius: '50%',
		flexShrink: 0,
		marginRight: 6,
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
		backgroundColor: 'rgba(25, 118, 210, 0.12)',
	} as CSSProperties,

	// -- time -------------------------------------------------------------------
	timeCol: {
		width: 64,
		flexShrink: 0,
		textAlign: 'right',
		paddingRight: 8,
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		fontFamily: 'var(--rr-font-mono, monospace)',
	} as CSSProperties,

	timeError: {
		width: 64,
		flexShrink: 0,
		textAlign: 'right',
		paddingRight: 8,
		fontSize: 11,
		fontFamily: 'var(--rr-font-mono, monospace)',
		color: 'var(--rr-color-error)',
		fontWeight: 600,
	} as CSSProperties,

	// -- "more..." row ----------------------------------------------------------
	moreLabel: {
		color: 'var(--rr-chart-blue)',
		fontStyle: 'italic',
		cursor: 'pointer',
		fontSize: 12,
	} as CSSProperties,

	// -- detail wrapper ---------------------------------------------------------
	detailWrapper: {
		position: 'relative',
		flexShrink: 0,
		overflowY: 'auto',
		overflowX: 'hidden',
		borderLeft: '1px solid var(--rr-border-default)',
	} as CSSProperties,

	resizeHandle: {
		position: 'absolute',
		top: 0,
		left: 0,
		width: 4,
		height: '100%',
		cursor: 'col-resize',
		zIndex: 10,
		background: 'transparent',
	} as CSSProperties,

	resizeHandleActive: {
		position: 'absolute',
		top: 0,
		left: 0,
		width: 4,
		height: '100%',
		cursor: 'col-resize',
		zIndex: 10,
		background: 'var(--rr-chart-blue)',
		opacity: 0.4,
	} as CSSProperties,

	// -- detail panel -----------------------------------------------------------
	dp: {
		padding: '12px 10px',
		fontSize: 12,
		lineHeight: '18px',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	dpEmpty: {
		padding: '24px 16px',
		textAlign: 'center',
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
	} as CSSProperties,

	dpHdr: {
		marginBottom: 12,
	} as CSSProperties,

	dpH2: {
		margin: 0,
		fontSize: 14,
		fontWeight: 700,
	} as CSSProperties,

	dpHint: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		marginTop: 2,
	} as CSSProperties,

	dpSect: {
		marginBottom: 6,
	} as CSSProperties,

	dpH3: {
		margin: '0 0 6px 0',
		fontSize: 11,
		fontWeight: 700,
		textTransform: 'uppercase',
		letterSpacing: '0.04em',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	dpKv: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'baseline',
		padding: '1px 0',
		gap: 8,
	} as CSSProperties,

	dpK: {
		color: 'var(--rr-text-secondary)',
		flexShrink: 0,
		fontSize: 11,
	} as CSSProperties,

	dpV: {
		textAlign: 'right',
		wordBreak: 'break-word',
		minWidth: 0,
	} as CSSProperties,

	dpTime: {
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontWeight: 600,
		textAlign: 'right',
	} as CSSProperties,

	dpBar: {
		height: 6,
		borderRadius: 3,
		backgroundColor: 'var(--rr-bg-surface)',
		overflow: 'hidden',
		marginTop: 4,
	} as CSSProperties,

	dpBarFill: {
		height: '100%',
		borderRadius: 3,
		backgroundColor: 'var(--rr-chart-blue)',
	} as CSSProperties,

	dpBarLabel: {
		fontSize: 10,
		color: 'var(--rr-text-secondary)',
		marginTop: 2,
	} as CSSProperties,

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

	dpExpandHint: {
		fontSize: 10,
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
		marginTop: 2,
		paddingLeft: 16,
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

		for (const row of docRows) {
			if (row.error) hasError = true;

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
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
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

// =============================================================================
// SUB-COMPONENT: Object (file) row -- top-level collapsible group
// =============================================================================

const TraceObjectRow: React.FC<{
	group: TraceObjectGroup;
	expanded: boolean;
	onToggle: () => void;
	onExpandAll: () => void;
	onCollapseAll: () => void;
}> = ({ group, expanded, onToggle, onExpandAll, onCollapseAll }) => {
	const [hovered, setHovered] = useState(false);

	const timeDisplay = group.hasError ? <span style={S.timeError}>ERROR</span> : <span style={S.timeCol}>{formatElapsed(group.totalElapsed)}</span>;

	const handleClick = (e: React.MouseEvent) => {
		if (e.shiftKey) {
			if (expanded) {
				onCollapseAll();
			} else {
				onExpandAll();
			}
		} else {
			onToggle();
		}
	};

	const chevronTitle = expanded ? 'Click to collapse (Shift-Click to collapse all)' : 'Click to expand (Shift-Click to expand all)';

	const rowStyle: CSSProperties = {
		...S.row,
		...(group.inFlight ? S.objectRowInFlight : S.objectRow),
		...(hovered ? S.rowHover : {}),
	};

	return (
		<div style={rowStyle} onClick={handleClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
			<span style={S.chev} title={chevronTitle}>
				{expanded ? '\u25BE' : '\u25B8'}
			</span>
			<span style={S.nameFile}>{group.objectName}</span>
			{group.inFlight && <span style={S.inFlightBadge}>processing</span>}
			<span style={{ flex: 1 }} />
			{timeDisplay}
		</div>
	);
};

// =============================================================================
// STYLES: Collapsed/Expanded call tree
// =============================================================================

const SN = {
	nest: {
		marginLeft: 20,
		borderLeft: '1px solid var(--rr-border-subtle, rgba(0,0,0,0.06))',
	} as CSSProperties,
	collapsedRow: {
		display: 'flex',
		alignItems: 'center',
		padding: '3px 8px',
		cursor: 'pointer',
		borderBottom: '1px solid rgba(0,0,0,0.025)',
		gap: 3,
		minHeight: 26,
	} as CSSProperties,
	expandedHeader: {
		display: 'flex',
		alignItems: 'center',
		padding: '3px 8px',
		cursor: 'pointer',
		borderBottom: '1px solid rgba(0,0,0,0.025)',
		gap: 3,
		minHeight: 26,
		background: 'var(--rr-bg-surface, rgba(0,0,0,0.015))',
	} as CSSProperties,
	enterLeaveRow: {
		display: 'flex',
		alignItems: 'center',
		padding: '2px 8px',
		cursor: 'pointer',
		borderBottom: '1px solid rgba(0,0,0,0.015)',
		gap: 5,
		minHeight: 24,
	} as CSSProperties,
	elLabel: {
		fontSize: 9,
		fontWeight: 700,
		textTransform: 'uppercase' as const,
		padding: '1px 5px',
		borderRadius: 2,
	} as CSSProperties,
	enterLabel: {
		color: 'var(--rr-color-success, #2b8a3e)',
		backgroundColor: 'rgba(43,138,62,0.08)',
	} as CSSProperties,
	leaveLabel: {
		color: 'var(--rr-color-warning, #e67a2e)',
		backgroundColor: 'rgba(230,122,46,0.08)',
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
		borderBottom: '1px solid rgba(0,0,0,0.025)',
		color: 'var(--rr-chart-blue, #4263eb)',
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
	selectedRowId: number | null;
	expandedNodes: Set<number>;
	moreRevealed: Map<string, number>;
	onToggleExpand: (id: number) => void;
	onExpandAll: (node: TraceTreeNode) => void;
	onCollapseAll: (node: TraceTreeNode) => void;
	onSelect: (id: number) => void;
	onRevealMore: (key: string) => void;
}

const TraceCallNode: React.FC<TraceCallNodeProps> = ({ node, selectedRowId, expandedNodes, moreRevealed, onToggleExpand, onExpandAll, onCollapseAll, onSelect, onRevealMore }) => {
	const { row } = node;
	const isExpanded = expandedNodes.has(row.id);
	const isError = !!row.error;
	const elapsed = getRowElapsed(row);
	const summary = summaryTraceData(row.entryData, row.lane) || summaryTraceData(row.exitData, row.lane) || dataSummary(row.entryData) || dataSummary(row.exitData) || '';

	if (!isExpanded) {
		// ── COLLAPSED: single row with ▸ ──
		const isSelected = selectedRowId === row.id;
		return (
			<>
				<div style={{ ...SN.collapsedRow, ...(isSelected ? S.rowSelected : {}), ...(isError && !isSelected ? S.rowError : {}) }} onClick={() => onToggleExpand(row.id)}>
					<span style={S.chev}>{'\u25B8'}</span>
					{isError && <span style={S.errIcon}>{'\u2716'}</span>}
					<span style={isError ? S.nameError : { ...S.name, flex: 'none' }}>{row.filterName}</span>
					<span style={badgeStyle(row.lane)}>{laneDisplayName(row.lane)}</span>
					{summary && <span style={SN.summary}>{summary}</span>}
					<span style={{ flex: 1 }} />
					{isError ? <span style={S.timeError}>ERROR</span> : <span style={S.timeCol}>{formatElapsed(elapsed)}</span>}
				</div>
				{isSelected && row.entryData && <InlineDataBox node={node} data={row.entryData} label="Input" lane={row.lane} showCallInfo />}
				{isSelected && (row.exitData || row.error) && <InlineDataBox node={node} data={row.error ? { error: row.error } : row.exitData} label="Output" lane={row.lane} defaultOpen={false} />}
			</>
		);
	}

	// ── EXPANDED: ▾ header → Input box → children → Output box ──
	return (
		<div>
			{/* ▾ Header */}
			<div style={SN.expandedHeader} onClick={() => onToggleExpand(row.id)}>
				<span style={S.chev}>{'\u25BE'}</span>
				{isError && <span style={S.errIcon}>{'\u2716'}</span>}
				<span style={isError ? S.nameError : { ...S.name, flex: 'none' }}>{row.filterName}</span>
				<span style={badgeStyle(row.lane)}>{laneDisplayName(row.lane)}</span>
				<span style={{ flex: 1 }} />
				{isError ? <span style={S.timeError}>ERROR</span> : <span style={S.timeCol}>{formatElapsed(elapsed)}</span>}
			</div>

			<div style={SN.nest}>
				{/* Input box with call info */}
				{row.entryData && <InlineDataBox node={node} data={row.entryData} label="Input" lane={row.lane} showCallInfo />}

				{/* Children */}
				<TraceCallChildren nodes={node.children} selectedRowId={selectedRowId} expandedNodes={expandedNodes} moreRevealed={moreRevealed} onToggleExpand={onToggleExpand} onExpandAll={onExpandAll} onCollapseAll={onCollapseAll} onSelect={onSelect} onRevealMore={onRevealMore} />

				{/* Output box — collapsed by default */}
				{(row.exitData || row.error) && <InlineDataBox node={node} data={row.error ? { error: row.error } : row.exitData} label="Output" lane={row.lane} defaultOpen={false} />}
			</div>
		</div>
	);
};

/** Data view mode toggle buttons and renderer. */
type DataViewMode = 'tree' | 'json' | 'raw';

const viewModeLabels: { mode: DataViewMode; label: string }[] = [
	{ mode: 'tree', label: 'Tree' },
	{ mode: 'json', label: 'JSON' },
	{ mode: 'raw', label: 'Raw' },
];

const DataViewToggle: React.FC<{ mode: DataViewMode; onChange: (m: DataViewMode) => void }> = ({ mode, onChange }) => (
	<div style={{ display: 'flex', gap: 1, marginLeft: 'auto' }}>
		{viewModeLabels.map((v) => (
			<button
				key={v.mode}
				onClick={(e) => {
					e.stopPropagation();
					onChange(v.mode);
				}}
				style={{
					padding: '1px 6px',
					fontSize: 9,
					fontWeight: 600,
					border: '1px solid var(--rr-border)',
					borderRadius: 2,
					cursor: 'pointer',
					backgroundColor: mode === v.mode ? 'var(--rr-brand)' : 'transparent',
					color: mode === v.mode ? 'var(--rr-fg-button, #fff)' : 'var(--rr-text-secondary)',
				}}
			>
				{v.label}
			</button>
		))}
	</div>
);

const DataRenderer: React.FC<{ data: unknown; mode: DataViewMode; lane?: string }> = ({ data, mode, lane }) => {
	if (mode === 'tree') {
		return renderTraceData(data, lane || '');
	}
	if (mode === 'json') {
		return (
			<div style={S.dpTree}>
				<JsonTree data={data} defaultExpanded={2} />
			</div>
		);
	}
	// raw
	return <pre style={{ ...S.dpTree, fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(data)}</pre>;
};

/** Inline data box — shown directly when a node is expanded. */
const InlineDataBox: React.FC<{ node: TraceTreeNode; data: unknown; label: string; lane: string; showCallInfo?: boolean; defaultOpen?: boolean }> = ({ node, data, label, lane, showCallInfo, defaultOpen = true }) => {
	const [expanded, setExpanded] = useState(defaultOpen);
	const [viewMode, setViewMode] = useState<DataViewMode>('json');

	const { row } = node;
	const elapsed = getRowElapsed(row);
	const parentElapsed = node.parent ? getRowElapsed(node.parent.row) : null;
	const pctOfParent = elapsed != null && parentElapsed != null && parentElapsed > 0 ? Math.round((elapsed / parentElapsed) * 100) : null;

	// Build call chain
	const chainParts: string[] = [];
	if (showCallInfo) {
		let p: TraceTreeNode | null = node;
		while (p) {
			chainParts.unshift(p.row.filterName);
			p = p.parent;
		}
	}

	const boxStyle: CSSProperties = {
		background: 'var(--rr-bg-widget)',
		borderRadius: 4,
		padding: '6px 10px',
		margin: '2px 0 4px',
		fontSize: 12,
	};

	const kvStyle: CSSProperties = { display: 'flex', gap: 8, fontSize: 11, lineHeight: '16px' };
	const kStyle: CSSProperties = { color: 'var(--rr-text-secondary)', flexShrink: 0, minWidth: 60 };
	const vStyle: CSSProperties = { color: 'var(--rr-text-primary)' };

	return (
		<div style={boxStyle}>
			{/* Call info (only on input box) */}
			{showCallInfo && (
				<div style={{ marginBottom: 6 }}>
					<div style={kvStyle}>
						<span style={kStyle}>Node</span>
						<span style={vStyle}>{row.filterName}</span>
					</div>
					<div style={kvStyle}>
						<span style={kStyle}>Called by</span>
						<span style={vStyle}>{node.parent?.row.filterName || '\u2014'}</span>
					</div>
					<div style={kvStyle}>
						<span style={kStyle}>Lane</span>
						<span style={vStyle}>
							<span style={badgeStyle(row.lane)}>{laneDisplayName(row.lane)}</span>
						</span>
					</div>
					{row.result && (
						<div style={kvStyle}>
							<span style={kStyle}>Result</span>
							<span style={vStyle}>{row.result}</span>
						</div>
					)}
					{chainParts.length > 1 && (
						<div style={kvStyle}>
							<span style={kStyle}>Chain</span>
							<span style={{ ...vStyle, display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
								{chainParts.map((name, i) => (
									<React.Fragment key={i}>
										{i > 0 && <span style={{ color: 'var(--rr-text-secondary)', fontSize: 10 }}>{'\u2192'}</span>}
										<span style={{ padding: '0 4px', borderRadius: 3, backgroundColor: 'var(--rr-bg-surface, #e9ecef)', fontSize: 11, fontWeight: 500 }}>{name}</span>
									</React.Fragment>
								))}
							</span>
						</div>
					)}
					{elapsed != null && (
						<div style={kvStyle}>
							<span style={kStyle}>Elapsed</span>
							<span style={{ ...vStyle, fontWeight: 600, fontFamily: 'var(--rr-font-mono, monospace)', color: 'var(--rr-brand, #e67a2e)' }}>{formatElapsed(elapsed)}</span>
							{pctOfParent != null && (
								<span style={{ color: 'var(--rr-text-secondary)', marginLeft: 6, fontSize: 10 }}>
									({pctOfParent}% of {node.parent!.row.filterName})
								</span>
							)}
						</div>
					)}
				</div>
			)}

			{/* Data section */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
				<div style={S.dpToggle} onClick={() => setExpanded(!expanded)}>
					<span style={S.dpArr}>{expanded ? '\u25BC' : '\u25B6'}</span>
					{label}
				</div>
				{expanded && <DataViewToggle mode={viewMode} onChange={setViewMode} />}
			</div>
			{expanded && <DataRenderer data={data} mode={viewMode} lane={lane} />}
		</div>
	);
};

/** Renders a list of children with batching for identical consecutive siblings. */
const TraceCallChildren: React.FC<Omit<TraceCallNodeProps, 'node'> & { nodes: TraceTreeNode[] }> = ({ nodes, selectedRowId, expandedNodes, moreRevealed, onToggleExpand, onExpandAll, onCollapseAll, onSelect, onRevealMore }) => {
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
				items.push(<TraceCallNode key={nodes[j].row.id} node={nodes[j]} selectedRowId={selectedRowId} expandedNodes={expandedNodes} moreRevealed={moreRevealed} onToggleExpand={onToggleExpand} onExpandAll={onExpandAll} onCollapseAll={onCollapseAll} onSelect={onSelect} onRevealMore={onRevealMore} />);
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
			items.push(<TraceCallNode key={nodes[i].row.id} node={nodes[i]} selectedRowId={selectedRowId} expandedNodes={expandedNodes} moreRevealed={moreRevealed} onToggleExpand={onToggleExpand} onExpandAll={onExpandAll} onCollapseAll={onCollapseAll} onSelect={onSelect} onRevealMore={onRevealMore} />);
			i++;
		}
	}
	return <>{items}</>;
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

const Trace: React.FC<TraceProps> = ({ rows }) => {
	const [expandedObjects, setExpandedObjects] = useState<Set<number>>(new Set());
	const [expandedNodes, setExpandedNodes] = useState<Set<number>>(new Set());
	const [selectedRowId, setSelectedRowId] = useState<number | null>(null);
	const [moreRevealed, setMoreRevealed] = useState<Map<string, number>>(new Map());

	const objectGroups = useMemo(() => buildObjectGroups(rows), [rows]);

	const toggleObject = useCallback((docId: number) => {
		setExpandedObjects((prev) => {
			const next = new Set(prev);
			if (next.has(docId)) next.delete(docId);
			else next.add(docId);
			return next;
		});
	}, []);

	const toggleNode = useCallback((id: number) => {
		setExpandedNodes((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const expandAllForObject = useCallback((group: TraceObjectGroup) => {
		const allIds = collectAllParentIds(group.nodes);
		setExpandedObjects((prev) => {
			const next = new Set(prev);
			next.add(group.docId);
			return next;
		});
		setExpandedNodes((prev) => {
			const next = new Set(prev);
			for (const id of allIds) next.add(id);
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

	const collapseAllForObject = useCallback((group: TraceObjectGroup) => {
		const allIds = collectAllParentIds(group.nodes);
		setExpandedObjects((prev) => {
			const next = new Set(prev);
			next.delete(group.docId);
			return next;
		});
		setExpandedNodes((prev) => {
			const next = new Set(prev);
			for (const id of allIds) next.delete(id);
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

	const selectRow = useCallback((id: number) => {
		setSelectedRowId((prev) => (prev === id ? null : id));
	}, []);

	return (
		<section style={S.section}>
			<div style={S.content}>
				{objectGroups.length === 0 ? (
					<div style={S.noData}>No trace data</div>
				) : (
					<div style={S.treeScroll}>
						{objectGroups.map((group) => {
							const isExpanded = expandedObjects.has(group.docId);

							return (
								<React.Fragment key={group.docId}>
									<TraceObjectRow group={group} expanded={isExpanded} onToggle={() => toggleObject(group.docId)} onExpandAll={() => expandAllForObject(group)} onCollapseAll={() => collapseAllForObject(group)} />
									{isExpanded && <TraceCallChildren nodes={group.nodes} selectedRowId={selectedRowId} expandedNodes={expandedNodes} moreRevealed={moreRevealed} onToggleExpand={(id) => toggleNode(id)} onExpandAll={expandAllForNode} onCollapseAll={collapseAllForNode} onSelect={selectRow} onRevealMore={revealMore} />}
								</React.Fragment>
							);
						})}
					</div>
				)}
			</div>
		</section>
	);
};

export default Trace;
