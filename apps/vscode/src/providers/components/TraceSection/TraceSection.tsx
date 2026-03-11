import React, { useState, useMemo, useCallback, useEffect } from 'react';

// ============================================================================
// TYPES
// ============================================================================

export interface TraceRow {
	id: number;
	docId: number;
	completed: boolean;
	lane: string;
	filterName: string;
	depth: number;
	entryData?: Record<string, unknown>;
	exitData?: Record<string, unknown>;
	result?: string;
	error?: string;
	timestamp: number;
	endTimestamp?: number;
	objectName: string;
}

export interface VideoResultEntry {
	uri: string;
	mimeType: string;
	sizeMB: number;
}

interface TraceSectionProps {
	rows: TraceRow[];
	videos: VideoResultEntry[];
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

// ============================================================================
// CONSTANTS
// ============================================================================

const LANE_COLORS: Record<string, string> = {
	open: 'var(--vscode-charts-blue, #1976d2)',
	tags: 'var(--vscode-charts-green, #2e7d32)',
	text: 'var(--vscode-charts-yellow, #f9a825)',
	documents: 'var(--vscode-charts-purple, #9c27b0)',
	closing: 'var(--vscode-charts-orange, #e65100)',
	close: 'var(--vscode-charts-red, #c62828)',
};

const LANE_DISPLAY_NAMES: Record<string, string> = {
	tags: 'data',
};

function laneDisplayName(lane: string): string {
	return LANE_DISPLAY_NAMES[lane] || lane;
}

// ============================================================================
// HELPER: Build tree from flat rows
// ============================================================================

function buildObjectGroups(rows: TraceRow[]): TraceObjectGroup[] {
	// Group rows by docId, preserving insertion order
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
				// Orphan — add to root
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
		groups.push({ docId, objectName, nodes: rootNodes, hasError, inFlight, totalElapsed });
	}

	return groups;
}

// ============================================================================
// HELPER: Find a node by id in a tree
// ============================================================================

function findNodeById(nodes: TraceTreeNode[], id: number): TraceTreeNode | null {
	for (const node of nodes) {
		if (node.row.id === id) return node;
		const found = findNodeById(node.children, id);
		if (found) return found;
	}
	return null;
}

// ============================================================================
// HELPER: Collect all visible nodes from a tree (respecting collapsed state)
// ============================================================================

function collectVisibleNodes(
	nodes: TraceTreeNode[],
	expandedNodes: Set<number>
): TraceTreeNode[] {
	const result: TraceTreeNode[] = [];
	for (const node of nodes) {
		result.push(node);
		if (node.children.length > 0 && expandedNodes.has(node.row.id)) {
			result.push(...collectVisibleNodes(node.children, expandedNodes));
		}
	}
	return result;
}

// ============================================================================
// HELPER: Build render items with "more..." batching
// ============================================================================

const BATCH_SIZE = 10;

type RenderItem =
	| { type: 'node'; node: TraceTreeNode }
	| { type: 'more'; remaining: number; groupKey: string; depth: number };

function buildRenderItems(
	nodes: TraceTreeNode[],
	moreRevealed: Map<string, number>
): RenderItem[] {
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
		while (
			runEnd < nodes.length &&
			nodes[runEnd].children.length === 0 &&
			nodes[runEnd].row.filterName === node.row.filterName &&
			nodes[runEnd].row.lane === node.row.lane &&
			nodes[runEnd].row.depth === node.row.depth
		) {
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
					depth: node.row.depth
				});
			}
		}

		i = runEnd;
	}

	return items;
}

// ============================================================================
// HELPER: Collect all parent node IDs in a subtree (for expand-all)
// ============================================================================

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

// ============================================================================
// HELPER: Format elapsed time
// ============================================================================

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

// ============================================================================
// HELPER: Lane color
// ============================================================================

function laneColor(lane: string): string {
	return LANE_COLORS[lane] || 'var(--vscode-descriptionForeground, #888)';
}

// ============================================================================
// SUB-COMPONENT: Tree column header
// ============================================================================

const TraceTreeHeader: React.FC = () => (
	<div className="trace-tree-hdr">
		<div className="trace-col-call">Call</div>
		<div className="trace-col-lane">Lane</div>
		<div className="trace-col-time">Time</div>
	</div>
);

// ============================================================================
// SUB-COMPONENT: Object (file) row — top-level collapsible group
// ============================================================================

const TraceObjectRow: React.FC<{
	group: TraceObjectGroup;
	expanded: boolean;
	onToggle: () => void;
	onExpandAll: () => void;
	onCollapseAll: () => void;
}> = ({ group, expanded, onToggle, onExpandAll, onCollapseAll }) => {
	const timeDisplay = group.hasError
		? <span className="trace-col-time trace-time-error">ERROR</span>
		: <span className="trace-col-time">{formatElapsed(group.totalElapsed)}</span>;

	const handleClick = (e: React.MouseEvent) => {
		if (e.shiftKey) {
			expanded ? onCollapseAll() : onExpandAll();
		} else {
			onToggle();
		}
	};

	const chevronTitle = expanded
		? 'Click to collapse (Shift-Click to collapse all)'
		: 'Click to expand (Shift-Click to expand all)';

	const rowClass = [
		'trace-row',
		'trace-object-row',
		group.inFlight ? 'trace-in-flight' : '',
	].filter(Boolean).join(' ');

	return (
		<div className={rowClass} onClick={handleClick}>
			<span className="trace-chev" title={chevronTitle}>{expanded ? '\u25BC' : '\u25B6'}</span>
			<span className="trace-name trace-name-file">{group.objectName}</span>
			<span className="trace-col-lane">
				{group.inFlight && <span className="trace-in-flight-badge">processing</span>}
			</span>
			{timeDisplay}
		</div>
	);
};

// ============================================================================
// SUB-COMPONENT: Individual call-tree node row
// ============================================================================

const TraceNodeRow: React.FC<{
	node: TraceTreeNode;
	expanded: boolean;
	selected: boolean;
	onToggleExpand: () => void;
	onExpandAll: () => void;
	onCollapseAll: () => void;
	onSelect: () => void;
}> = ({ node, expanded, selected, onToggleExpand, onExpandAll, onCollapseAll, onSelect }) => {
	const { row } = node;
	const hasChildren = node.children.length > 0;
	const isError = !!row.error;
	const elapsed = getRowElapsed(row);
	const indent = row.depth * 20 + 28;

	const className = [
		'trace-row',
		selected ? 'selected' : '',
		isError ? 'error' : '',
	].filter(Boolean).join(' ');

	const handleClick = () => {
		onSelect();
	};

	const handleChevronClick = (e: React.MouseEvent) => {
		if (hasChildren) {
			e.stopPropagation();
			if (e.shiftKey) {
				expanded ? onCollapseAll() : onExpandAll();
			} else {
				onToggleExpand();
			}
		}
	};

	const chevronTitle = hasChildren
		? (expanded
			? 'Click to collapse (Shift-Click to collapse all)'
			: 'Click to expand (Shift-Click to expand all)')
		: undefined;

	return (
		<div className={className} style={{ paddingLeft: indent }} onClick={handleClick}>
			<span
				className="trace-chev"
				onClick={handleChevronClick}
				title={chevronTitle}
			>
				{hasChildren ? (expanded ? '\u25BC' : '\u25B6') : ''}
			</span>
			{isError && <span className="trace-err-icon">{'\u2716'}</span>}
			<span className="trace-dot" style={{ backgroundColor: laneColor(row.lane) }} />
			<span className={`trace-name ${isError ? 'trace-name-error' : ''}`}>
				{row.filterName}
			</span>
			<span className="trace-col-lane">
				<span className={`trace-badge trace-badge-${row.lane}`}>{laneDisplayName(row.lane)}</span>
			</span>
			{isError
				? <span className="trace-col-time trace-time-error">ERROR</span>
				: <span className="trace-col-time">{formatElapsed(elapsed)}</span>
			}
		</div>
	);
};

// ============================================================================
// SUB-COMPONENT: Detail panel
// ============================================================================

const TraceDetailPanel: React.FC<{
	node: TraceTreeNode | null;
	videos: VideoResultEntry[];
}> = ({ node, videos }) => {
	const [inputExpanded, setInputExpanded] = useState(true);
	const [outputExpanded, setOutputExpanded] = useState(false);

	if (!node) {
		return (
			<div className="trace-detail-panel">
				<div className="trace-dp-empty">Click a row to view details</div>
			</div>
		);
	}

	const { row } = node;
	const elapsed = getRowElapsed(row);
	const parentElapsed = node.parent ? getRowElapsed(node.parent.row) : null;
	const pctOfParent = elapsed != null && parentElapsed != null && parentElapsed > 0
		? Math.round((elapsed / parentElapsed) * 100)
		: null;

	return (
		<div className="trace-detail-panel">
			<div className="trace-dp-hdr">
				<h2>Node Detail</h2>
				<div className="trace-dp-hint">{row.filterName}</div>
			</div>

			{/* Call Info */}
			<div className="trace-dp-sect">
				<h3>Call Info</h3>
				<div className="trace-dp-kv">
					<span className="trace-dp-k">Node</span>
					<span className="trace-dp-v">{row.filterName}</span>
				</div>
				<div className="trace-dp-kv">
					<span className="trace-dp-k">Called by</span>
					<span className="trace-dp-v">{node.parent?.row.filterName || '\u2014'}</span>
				</div>
				<div className="trace-dp-kv">
					<span className="trace-dp-k">Lane</span>
					<span className="trace-dp-v">
						<span className={`trace-badge trace-badge-${row.lane}`}>{laneDisplayName(row.lane)}</span>
					</span>
				</div>
				{row.result && (
					<div className="trace-dp-kv">
						<span className="trace-dp-k">Result</span>
						<span className="trace-dp-v">{row.result}</span>
					</div>
				)}
				<div className="trace-dp-kv">
					<span className="trace-dp-k">Depth</span>
					<span className="trace-dp-v">{row.depth}</span>
				</div>
			</div>

			{/* Elapsed Time */}
			{elapsed != null && (
				<div className="trace-dp-sect">
					<h3>Elapsed Time</h3>
					<div className="trace-dp-kv">
						<span className="trace-dp-k">Self</span>
						<span className="trace-dp-time">{formatElapsed(elapsed)}</span>
					</div>
					{pctOfParent != null && (
						<>
							<div className="trace-dp-bar">
								<div
									className="trace-dp-bar-fill"
									style={{ width: `${Math.min(pctOfParent, 100)}%` }}
								/>
							</div>
							<div className="trace-dp-bar-label">
								{pctOfParent}% of parent ({node.parent!.row.filterName}.{node.parent!.row.lane}: {formatElapsed(parentElapsed)})
							</div>
						</>
					)}
				</div>
			)}

			{/* Input Data */}
			{row.entryData && (
				<div className="trace-dp-sect">
					<div
						className="trace-dp-toggle"
						onClick={() => setInputExpanded(!inputExpanded)}
					>
						<span className="trace-dp-arr">{inputExpanded ? '\u25BC' : '\u25B6'}</span>
						Input Data
					</div>
					{inputExpanded && (
						<pre className="trace-dp-code">
							{JSON.stringify(row.entryData, null, 2)}
						</pre>
					)}
				</div>
			)}

			{/* Output Data */}
			{(row.exitData || row.error) && (
				<div className="trace-dp-sect">
					<div
						className="trace-dp-toggle"
						onClick={() => setOutputExpanded(!outputExpanded)}
					>
						<span className="trace-dp-arr">{outputExpanded ? '\u25BC' : '\u25B6'}</span>
						Output Data
					</div>
					{outputExpanded && (
						<pre className="trace-dp-code">
							{JSON.stringify(
								row.error
									? { error: row.error }
									: row.exitData,
								null, 2
							)}
						</pre>
					)}
					{!outputExpanded && (
						<div className="trace-dp-expand-hint">Click to expand</div>
					)}
				</div>
			)}

			{/* Video Player */}
			{videos.length > 0 && (
				<div className="trace-dp-sect">
					<h3>Video Result</h3>
					{videos.map((v, i) => (
						<div key={i} className="trace-video-player">
							<video controls preload="metadata">
								<source src={v.uri} type={v.mimeType} />
							</video>
							<div className="trace-video-meta">{v.sizeMB} MB</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const TraceSection: React.FC<TraceSectionProps> = ({
	rows,
	videos,
	onClear
}) => {
	const [expandedObjects, setExpandedObjects] = useState<Set<number>>(new Set());
	const [expandedNodes, setExpandedNodes] = useState<Set<number>>(new Set());
	const [selectedRowId, setSelectedRowId] = useState<number | null>(null);
	const [moreRevealed, setMoreRevealed] = useState<Map<string, number>>(new Map());

	// Detail panel resize state
	const [detailWidth, setDetailWidth] = useState(280);
	const [isResizing, setIsResizing] = useState(false);
	const [resizeStartX, setResizeStartX] = useState(0);
	const [resizeStartWidth, setResizeStartWidth] = useState(0);

	const handleResizeStart = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		setIsResizing(true);
		setResizeStartX(e.clientX);
		setResizeStartWidth(detailWidth);
	}, [detailWidth]);

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
		setExpandedObjects(prev => {
			const next = new Set(prev);
			if (next.has(docId)) next.delete(docId);
			else next.add(docId);
			return next;
		});
	}, []);

	const toggleNode = useCallback((id: number) => {
		setExpandedNodes(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const expandAllForObject = useCallback((group: TraceObjectGroup) => {
		const allIds = collectAllParentIds(group.nodes);
		setExpandedObjects(prev => {
			const next = new Set(prev);
			next.add(group.docId);
			return next;
		});
		setExpandedNodes(prev => {
			const next = new Set(prev);
			for (const id of allIds) next.add(id);
			return next;
		});
	}, []);

	const expandAllForNode = useCallback((node: TraceTreeNode) => {
		const allIds = collectAllParentIds(node.children);
		setExpandedNodes(prev => {
			const next = new Set(prev);
			next.add(node.row.id);
			for (const id of allIds) next.add(id);
			return next;
		});
	}, []);

	const collapseAllForObject = useCallback((group: TraceObjectGroup) => {
		const allIds = collectAllParentIds(group.nodes);
		setExpandedObjects(prev => {
			const next = new Set(prev);
			next.delete(group.docId);
			return next;
		});
		setExpandedNodes(prev => {
			const next = new Set(prev);
			for (const id of allIds) next.delete(id);
			return next;
		});
	}, []);

	const collapseAllForNode = useCallback((node: TraceTreeNode) => {
		const allIds = collectAllParentIds(node.children);
		setExpandedNodes(prev => {
			const next = new Set(prev);
			next.delete(node.row.id);
			for (const id of allIds) next.delete(id);
			return next;
		});
	}, []);

	const revealMore = useCallback((groupKey: string) => {
		setMoreRevealed(prev => {
			const next = new Map(prev);
			next.set(groupKey, (next.get(groupKey) ?? 0) + 1);
			return next;
		});
	}, []);

	const selectRow = useCallback((id: number) => {
		setSelectedRowId(prev => prev === id ? null : id);
	}, []);

	return (
		<section className="status-section">
			<header className="section-header">
				<span>Trace</span>
				<div className="trace-controls">
					{rows.length > 0 && (
						<button className="trace-clear-btn" onClick={onClear}>
							Clear
						</button>
					)}
				</div>
			</header>
			<div className="section-content">
				{objectGroups.length === 0 ? (
					<div className="no-data">No trace data</div>
				) : (
					<div className="trace-layout">
						<div className="trace-tree-scroll">
							<TraceTreeHeader />
							{objectGroups.map(group => {
								const isExpanded = expandedObjects.has(group.docId);
								const visibleNodes = isExpanded
									? collectVisibleNodes(group.nodes, expandedNodes)
									: [];
								const renderItems = isExpanded
									? buildRenderItems(visibleNodes, moreRevealed)
									: [];

								return (
									<React.Fragment key={group.docId}>
										<TraceObjectRow
											group={group}
											expanded={isExpanded}
											onToggle={() => toggleObject(group.docId)}
											onExpandAll={() => expandAllForObject(group)}
											onCollapseAll={() => collapseAllForObject(group)}
										/>
										{renderItems.map(item => {
											if (item.type === 'node') {
												const node = item.node;
												return (
													<TraceNodeRow
														key={node.row.id}
														node={node}
														expanded={expandedNodes.has(node.row.id)}
														selected={selectedRowId === node.row.id}
														onToggleExpand={() => toggleNode(node.row.id)}
														onExpandAll={() => expandAllForNode(node)}
														onCollapseAll={() => collapseAllForNode(node)}
														onSelect={() => selectRow(node.row.id)}
													/>
												);
											}
											return (
												<div
													key={`more-${item.groupKey}`}
													className="trace-row trace-more-row"
													style={{ paddingLeft: item.depth * 20 + 28 }}
													onClick={() => revealMore(item.groupKey)}
												>
													<span className="trace-chev" />
													<span className="trace-more-label">
														{item.remaining} more... (click to show next {Math.min(BATCH_SIZE, item.remaining)})
													</span>
												</div>
											);
										})}
									</React.Fragment>
								);
							})}
						</div>
						<div className="trace-detail-wrapper" style={{ width: detailWidth }}>
							<div
								className="trace-resize-handle"
								onMouseDown={handleResizeStart}
								aria-label="Resize detail panel"
							/>
							<TraceDetailPanel node={selectedNode} videos={videos} />
						</div>
					</div>
				)}
			</div>
		</section>
	);
};
