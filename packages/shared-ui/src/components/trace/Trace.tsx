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
	/** Map of component id → display name from the pipeline definition. */
	componentNames?: Map<string, string>;
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
		fontFamily: 'var(--rr-font-family)',
		fontSize: 13,
	} as CSSProperties,

	content: {
		flex: 1,
		overflow: 'hidden',
	} as CSSProperties,

	noData: {
		...commonStyles.empty,
		fontStyle: 'italic',
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
		borderBottom: '1px solid var(--rr-border)',
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

	const totalCalls = countAllNodes(group.nodes);
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
			{totalCalls > 0 && <span style={{ fontSize: 10, color: 'var(--rr-text-disabled)', marginRight: 4 }}>({totalCalls} calls)</span>}
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
	const summary = summaryTraceData(row.entryData, row.lane) || summaryTraceData(row.exitData, row.lane) || dataSummary(row.entryData) || dataSummary(row.exitData) || '';
	const name = resolveDisplayName(row.filterName, componentNames);
	const childCount = countAllNodes(node.children);

	const nameStyle: CSSProperties = isError ? S.nameError : isEmpty ? { ...S.name, flex: 'none', color: 'var(--rr-text-disabled)' } : { ...S.name, flex: 'none' };

	if (!isExpanded) {
		// ── COLLAPSED: single row with ▸ ──
		return (
			<div style={{ ...SN.collapsedRow, ...(isError ? S.rowError : {}) }} onClick={() => onToggleExpand(row.id)}>
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
			<div style={SN.expandedHeader} onClick={() => onToggleExpand(row.id)}>
				<span style={S.chev}>{'\u25BE'}</span>
				{isError && <span style={S.errIcon}>{'\u2716'}</span>}
				<span style={nameStyle}>{name}</span>
				<span style={badgeStyle(row.lane)}>{laneDisplayName(row.lane)}</span>
				<span style={{ flex: 1 }} />
				{childCount > 0 && <span style={{ fontSize: 10, color: 'var(--rr-text-disabled)', marginRight: 4 }}>({childCount} calls)</span>}
				{isError ? <span style={S.timeError}>ERROR</span> : <span style={S.timeCol}>{formatElapsed(elapsed)}</span>}
			</div>

			<div style={SN.nest}>
				{/* Input box with call info — always show call info even if no data */}
				<InlineDataBox node={node} data={row.entryData} label="Input" lane={row.lane} componentNames={componentNames} showCallInfo />

				{/* Children */}
				<TraceCallChildren nodes={node.children} componentNames={componentNames} expandedNodes={expandedNodes} moreRevealed={moreRevealed} onToggleExpand={onToggleExpand} onExpandAll={onExpandAll} onCollapseAll={onCollapseAll} onRevealMore={onRevealMore} />

				{/* Output box — collapsed by default */}
				{(row.exitData || row.error || row.result) && <InlineDataBox node={node} data={row.error ? { error: row.error } : row.exitData} label="Output" lane={row.lane} componentNames={componentNames} showResult defaultOpen={false} />}
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
	<div style={{ display: 'flex', gap: 1, marginLeft: 'auto' }}>
		{modes.map((v) => (
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
					color: mode === v.mode ? 'var(--rr-fg-button)' : 'var(--rr-text-secondary)',
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
	return <pre style={{ ...S.dpTree, fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(data)}</pre>;
};

/** Inline data box — shown directly when a node is expanded. */
const InlineDataBox: React.FC<{ node: TraceTreeNode; data: unknown; label: string; lane: string; componentNames?: Map<string, string>; showCallInfo?: boolean; showResult?: boolean; defaultOpen?: boolean }> = ({ node, data, label, lane, componentNames, showCallInfo, showResult, defaultOpen = true }) => {
	const hasTreeView = data != null && renderTraceData(data, lane) != null;
	const availableModes = hasTreeView ? VIEW_MODES : VIEW_MODES.filter((v) => v.mode !== 'tree');
	const [expanded, setExpanded] = useState(defaultOpen);
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

	// Result text for the output box header
	const resultText = showResult && row.result ? row.result : null;

	return (
		<div style={boxStyle}>
			{/* Call info (only on input box) */}
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

			{/* Result info (only on output box, when expanded) */}
			{showResult && expanded && resultText && (
				<div style={{ ...kvStyle, marginBottom: 6 }}>
					<span style={kStyle}>Result</span>
					<span style={vStyle}>{resultText}</span>
				</div>
			)}

			{/* Data section — only if data exists */}
			{data != null && (
				<>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<div style={S.dpToggle} onClick={() => setExpanded(!expanded)}>
							<span style={S.dpArr}>{expanded ? '\u25BC' : '\u25B6'}</span>
							{label}
						</div>
						{/* Inline result hint when collapsed */}
						{!expanded && resultText && (
							<span style={{ fontSize: 11, color: 'var(--rr-text-secondary)', fontStyle: 'italic' }}>
								{'\u2014'} {resultText}
							</span>
						)}
						{expanded && <DataViewToggle mode={viewMode} modes={availableModes} onChange={setViewMode} />}
					</div>
					{expanded && (
						<div style={{ padding: '0 8px' }}>
							<DataRenderer data={data} mode={viewMode} lane={lane} />
						</div>
					)}
				</>
			)}

			{/* Output box with no data — just show the result inline */}
			{data == null && resultText && (
				<div style={{ fontSize: 11, color: 'var(--rr-text-secondary)' }}>
					{label} {'\u2014'} {resultText}
				</div>
			)}
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
// MAIN COMPONENT
// =============================================================================

const Trace: React.FC<TraceProps> = ({ rows, componentNames }) => {
	const [expandedObjects, setExpandedObjects] = useState<Set<number>>(new Set());
	const [expandedNodes, setExpandedNodes] = useState<Set<number>>(new Set());
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
									{isExpanded && (
										<div style={{ paddingLeft: 20 }}>
											<TraceCallChildren nodes={group.nodes} componentNames={componentNames} expandedNodes={expandedNodes} moreRevealed={moreRevealed} onToggleExpand={(id) => toggleNode(id)} onExpandAll={expandAllForNode} onCollapseAll={collapseAllForNode} onRevealMore={revealMore} />
										</div>
									)}
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
