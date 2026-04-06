/**
 * @file Trace — pipeline call-tree viewer with detail panel
 * @license MIT
 *
 * Ported from apps/vscode TraceSection/TraceSection.tsx.
 * All styles are inline CSSProperties objects; no external CSS files.
 * Colour tokens use the --rr-* namespace.
 */
import React, { useState, useMemo, useCallback, useEffect, CSSProperties } from 'react';
import { JsonTree } from './JsonTree';
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
};

const LANE_DISPLAY_NAMES: Record<string, string> = {
	tags: 'data',
};

function laneDisplayName(lane: string): string {
	return LANE_DISPLAY_NAMES[lane] || lane;
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
		width: 18,
		flexShrink: 0,
		textAlign: 'center',
		fontSize: 10,
		color: 'var(--rr-text-secondary)',
		userSelect: 'none',
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
		marginBottom: 14,
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
		padding: '2px 0',
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
		backgroundColor: 'var(--rr-bg-default)',
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

function badgeStyle(lane: string): CSSProperties {
	const color = LANE_COLORS[lane] || 'var(--rr-text-secondary)';
	return {
		...S.badge,
		color,
		backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
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

	for (const [docId, docRows] of grouped) {
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
// HELPER: Find a node by id in a tree
// =============================================================================

function findNodeById(nodes: TraceTreeNode[], id: number): TraceTreeNode | null {
	for (const node of nodes) {
		if (node.row.id === id) return node;
		const found = findNodeById(node.children, id);
		if (found) return found;
	}
	return null;
}

// =============================================================================
// HELPER: Collect all visible nodes (respecting collapsed state)
// =============================================================================

function collectVisibleNodes(nodes: TraceTreeNode[], expandedNodes: Set<number>): TraceTreeNode[] {
	const result: TraceTreeNode[] = [];
	for (const node of nodes) {
		result.push(node);
		if (node.children.length > 0 && expandedNodes.has(node.row.id)) {
			result.push(...collectVisibleNodes(node.children, expandedNodes));
		}
	}
	return result;
}

// =============================================================================
// HELPER: Build render items with "more..." batching
// =============================================================================

type RenderItem = { type: 'node'; node: TraceTreeNode } | { type: 'more'; remaining: number; groupKey: string; depth: number };

function buildRenderItems(nodes: TraceTreeNode[], moreRevealed: Map<string, number>): RenderItem[] {
	const items: RenderItem[] = [];
	let i = 0;

	while (i < nodes.length) {
		const node = nodes[i];
		const isLeaf = node.children.length === 0;

		if (!isLeaf) {
			items.push({ type: 'node', node });
			i++;
			continue;
		}

		// Find consecutive run of identical leaf nodes (same filterName + lane + depth)
		let runEnd = i + 1;
		while (runEnd < nodes.length && nodes[runEnd].children.length === 0 && nodes[runEnd].row.filterName === node.row.filterName && nodes[runEnd].row.lane === node.row.lane && nodes[runEnd].row.depth === node.row.depth) {
			runEnd++;
		}

		const runLength = runEnd - i;

		if (runLength <= BATCH_SIZE) {
			for (let j = i; j < runEnd; j++) {
				items.push({ type: 'node', node: nodes[j] });
			}
		} else {
			const groupKey = String(node.row.id);
			const batches = moreRevealed.get(groupKey) ?? 0;
			const showCount = Math.min(BATCH_SIZE + batches * BATCH_SIZE, runLength);

			for (let j = i; j < i + showCount; j++) {
				items.push({ type: 'node', node: nodes[j] });
			}

			const remaining = runLength - showCount;
			if (remaining > 0) {
				items.push({
					type: 'more',
					remaining,
					groupKey,
					depth: node.row.depth,
				});
			}
		}

		i = runEnd;
	}

	return items;
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
	return LANE_COLORS[lane] || 'var(--rr-text-secondary)';
}

// =============================================================================
// SUB-COMPONENT: Tree column header
// =============================================================================

const TraceTreeHeader: React.FC = () => (
	<div style={S.treeHdr}>
		<div style={S.colCall}>Call</div>
		<div style={S.colLane}>Lane</div>
		<div style={S.colTime}>Time</div>
	</div>
);

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
				{expanded ? '\u25BC' : '\u25B6'}
			</span>
			<span style={S.nameFile}>{group.objectName}</span>
			<span style={S.colLane}>{group.inFlight && <span style={S.inFlightBadge}>processing</span>}</span>
			{timeDisplay}
		</div>
	);
};

// =============================================================================
// SUB-COMPONENT: Individual call-tree node row
// =============================================================================

const TraceNodeRow: React.FC<{
	node: TraceTreeNode;
	expanded: boolean;
	selected: boolean;
	onToggleExpand: () => void;
	onExpandAll: () => void;
	onCollapseAll: () => void;
	onSelect: () => void;
}> = ({ node, expanded, selected, onToggleExpand, onExpandAll, onCollapseAll, onSelect }) => {
	const [hovered, setHovered] = useState(false);
	const { row } = node;
	const hasChildren = node.children.length > 0;
	const isError = !!row.error;
	const elapsed = getRowElapsed(row);
	const indent = row.depth * 20 + 28;

	const rowStyle: CSSProperties = {
		...S.row,
		paddingLeft: indent,
		...(selected ? S.rowSelected : {}),
		...(isError && !selected ? S.rowError : {}),
		...(hovered && !selected ? S.rowHover : {}),
	};

	const handleClick = () => {
		onSelect();
	};

	const handleChevronClick = (e: React.MouseEvent) => {
		if (hasChildren) {
			e.stopPropagation();
			if (e.shiftKey) {
				if (expanded) {
					onCollapseAll();
				} else {
					onExpandAll();
				}
			} else {
				onToggleExpand();
			}
		}
	};

	const chevronTitle = hasChildren ? (expanded ? 'Click to collapse (Shift-Click to collapse all)' : 'Click to expand (Shift-Click to expand all)') : undefined;

	return (
		<div style={rowStyle} onClick={handleClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
			<span style={S.chev} onClick={handleChevronClick} title={chevronTitle}>
				{hasChildren ? (expanded ? '\u25BC' : '\u25B6') : ''}
			</span>
			{isError && <span style={S.errIcon}>{'\u2716'}</span>}
			<span style={{ ...S.dot, backgroundColor: laneColor(row.lane) }} />
			<span style={isError ? S.nameError : S.name}>{row.filterName}</span>
			<span style={S.colLane}>
				<span style={badgeStyle(row.lane)}>{laneDisplayName(row.lane)}</span>
			</span>
			{isError ? <span style={S.timeError}>ERROR</span> : <span style={S.timeCol}>{formatElapsed(elapsed)}</span>}
		</div>
	);
};

// =============================================================================
// SUB-COMPONENT: Detail panel
// =============================================================================

const TraceDetailPanel: React.FC<{
	node: TraceTreeNode | null;
}> = ({ node }) => {
	const [inputExpanded, setInputExpanded] = useState(true);
	const [outputExpanded, setOutputExpanded] = useState(false);

	if (!node) {
		return <div style={S.dpEmpty}>Click a row to view details</div>;
	}

	const { row } = node;
	const elapsed = getRowElapsed(row);
	const parentElapsed = node.parent ? getRowElapsed(node.parent.row) : null;
	const pctOfParent = elapsed != null && parentElapsed != null && parentElapsed > 0 ? Math.round((elapsed / parentElapsed) * 100) : null;

	return (
		<div style={S.dp}>
			{/* Header */}
			<div style={S.dpHdr}>
				<h2 style={S.dpH2}>Node Detail</h2>
				<div style={S.dpHint}>{row.filterName}</div>
			</div>

			{/* Call Info */}
			<div style={S.dpSect}>
				<h3 style={S.dpH3}>Call Info</h3>
				<div style={S.dpKv}>
					<span style={S.dpK}>Node</span>
					<span style={S.dpV}>{row.filterName}</span>
				</div>
				<div style={S.dpKv}>
					<span style={S.dpK}>Called by</span>
					<span style={S.dpV}>{node.parent?.row.filterName || '\u2014'}</span>
				</div>
				<div style={S.dpKv}>
					<span style={S.dpK}>Lane</span>
					<span style={S.dpV}>
						<span style={badgeStyle(row.lane)}>{laneDisplayName(row.lane)}</span>
					</span>
				</div>
				{row.result && (
					<div style={S.dpKv}>
						<span style={S.dpK}>Result</span>
						<span style={S.dpV}>{row.result}</span>
					</div>
				)}
				<div style={S.dpKv}>
					<span style={S.dpK}>Depth</span>
					<span style={S.dpV}>{row.depth}</span>
				</div>
			</div>

			{/* Elapsed Time */}
			{elapsed != null && (
				<div style={S.dpSect}>
					<h3 style={S.dpH3}>Elapsed Time</h3>
					<div style={S.dpKv}>
						<span style={S.dpK}>Self</span>
						<span style={S.dpTime}>{formatElapsed(elapsed)}</span>
					</div>
					{pctOfParent != null && (
						<>
							<div style={S.dpBar}>
								<div
									style={{
										...S.dpBarFill,
										width: `${Math.min(pctOfParent, 100)}%`,
									}}
								/>
							</div>
							<div style={S.dpBarLabel}>
								{pctOfParent}% of parent ({node.parent!.row.filterName}.{node.parent!.row.lane}: {formatElapsed(parentElapsed)})
							</div>
						</>
					)}
				</div>
			)}

			{/* Input Data */}
			{row.entryData && (
				<div style={S.dpSect}>
					<div style={S.dpToggle} onClick={() => setInputExpanded(!inputExpanded)}>
						<span style={S.dpArr}>{inputExpanded ? '\u25BC' : '\u25B6'}</span>
						Input Data
					</div>
					{inputExpanded && (
						<div style={S.dpTree}>
							<JsonTree data={row.entryData} defaultExpanded={2} />
						</div>
					)}
				</div>
			)}

			{/* Output Data */}
			{(row.exitData || row.error) && (
				<div style={S.dpSect}>
					<div style={S.dpToggle} onClick={() => setOutputExpanded(!outputExpanded)}>
						<span style={S.dpArr}>{outputExpanded ? '\u25BC' : '\u25B6'}</span>
						Output Data
					</div>
					{outputExpanded && (
						<div style={S.dpTree}>
							<JsonTree data={row.error ? { error: row.error } : row.exitData} defaultExpanded={2} />
						</div>
					)}
					{!outputExpanded && <div style={S.dpExpandHint}>Click to expand</div>}
				</div>
			)}
		</div>
	);
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

const Trace: React.FC<TraceProps> = ({ rows, onClear }) => {
	const [expandedObjects, setExpandedObjects] = useState<Set<number>>(new Set());
	const [expandedNodes, setExpandedNodes] = useState<Set<number>>(new Set());
	const [selectedRowId, setSelectedRowId] = useState<number | null>(null);
	const [moreRevealed, setMoreRevealed] = useState<Map<string, number>>(new Map());

	// Detail panel resize state
	const [detailWidth, setDetailWidth] = useState(280);
	const [isResizing, setIsResizing] = useState(false);
	const [resizeStartX, setResizeStartX] = useState(0);
	const [resizeStartWidth, setResizeStartWidth] = useState(0);

	const handleResizeStart = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			setIsResizing(true);
			setResizeStartX(e.clientX);
			setResizeStartWidth(detailWidth);
		},
		[detailWidth]
	);

	useEffect(() => {
		if (!isResizing) return;
		const onMove = (e: MouseEvent) => {
			const delta = resizeStartX - e.clientX;
			const next = Math.min(600, Math.max(200, resizeStartWidth + delta));
			setDetailWidth(next);
		};
		const onUp = () => setIsResizing(false);
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
		return () => {
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
		};
	}, [isResizing, resizeStartX, resizeStartWidth]);

	const objectGroups = useMemo(() => buildObjectGroups(rows), [rows]);

	// Find the selected node across all groups
	const selectedNode = useMemo(() => {
		if (selectedRowId == null) return null;
		for (const group of objectGroups) {
			const found = findNodeById(group.nodes, selectedRowId);
			if (found) return found;
		}
		return null;
	}, [selectedRowId, objectGroups]);

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
			<header style={S.header}>
				<span>Trace</span>
				<div style={S.controls}>
					{rows.length > 0 && (
						<button style={S.clearBtn} onClick={onClear}>
							Clear
						</button>
					)}
				</div>
			</header>
			<div style={S.content}>
				{objectGroups.length === 0 ? (
					<div style={S.noData}>No trace data</div>
				) : (
					<div style={S.layout}>
						<div style={S.treeScroll}>
							<TraceTreeHeader />
							{objectGroups.map((group) => {
								const isExpanded = expandedObjects.has(group.docId);
								const visibleNodes = isExpanded ? collectVisibleNodes(group.nodes, expandedNodes) : [];
								const renderItems = isExpanded ? buildRenderItems(visibleNodes, moreRevealed) : [];

								return (
									<React.Fragment key={group.docId}>
										<TraceObjectRow group={group} expanded={isExpanded} onToggle={() => toggleObject(group.docId)} onExpandAll={() => expandAllForObject(group)} onCollapseAll={() => collapseAllForObject(group)} />
										{renderItems.map((item) => {
											if (item.type === 'node') {
												const nd = item.node;
												return <TraceNodeRow key={nd.row.id} node={nd} expanded={expandedNodes.has(nd.row.id)} selected={selectedRowId === nd.row.id} onToggleExpand={() => toggleNode(nd.row.id)} onExpandAll={() => expandAllForNode(nd)} onCollapseAll={() => collapseAllForNode(nd)} onSelect={() => selectRow(nd.row.id)} />;
											}
											return (
												<div
													key={`more-${item.groupKey}`}
													style={{
														...S.row,
														paddingLeft: item.depth * 20 + 28,
													}}
													onClick={() => revealMore(item.groupKey)}
												>
													<span style={S.chev} />
													<span style={S.moreLabel}>
														{item.remaining} more... (click to show next {Math.min(BATCH_SIZE, item.remaining)})
													</span>
												</div>
											);
										})}
									</React.Fragment>
								);
							})}
						</div>
						<div style={{ ...S.detailWrapper, width: detailWidth }}>
							<div style={isResizing ? S.resizeHandleActive : S.resizeHandle} onMouseDown={handleResizeStart} aria-label="Resize detail panel" />
							<TraceDetailPanel node={selectedNode} />
						</div>
					</div>
				)}
			</div>
		</section>
	);
};

export default Trace;
