// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// STATS TABLE — SnakeViz-style sortable flat function table
// =============================================================================
//
// Column order matches snakeviz / pstats output:
//   ncalls | tottime | percall | cumtime | percall | filename:lineno(function)
//
// Row click = re-root the visualisation (not just cross-highlight).
// Table always shows ALL functions regardless of current viz root.
// =============================================================================

import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shared/themes/styles';
import type { ProfileTreeNode, ProfileTreeResponse, OnRootChange } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** Aggregated stats for one unique function across all call sites. */
interface FlatRow {
	/** Function name. */
	name: string;
	/** Source filename. */
	file: string;
	/** Source line number. */
	line: number;
	/** Total call count. */
	ncalls: number;
	/** Self time (excludes sub-calls). */
	tottime: number;
	/** tottime / ncalls. */
	percall: number;
	/** Cumulative time (includes sub-calls). */
	cumtime: number;
	/** cumtime / ncalls. */
	cumpercall: number;
	/** Combined pstats-style location string. */
	location: string;
	/** Reference to the original tree node (for re-rooting). */
	refNode: ProfileTreeNode;
}

/** Sortable column identifiers. */
type SortColumn = 'ncalls' | 'tottime' | 'percall' | 'cumtime' | 'cumpercall' | 'location';

/** Sort direction. */
type SortDir = 'asc' | 'desc';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Number of rows to render per chunk for windowed rendering. */
const CHUNK_SIZE = 200;

/** Column definitions — matches snakeviz / pstats output order. */
const COLUMNS: { key: SortColumn; label: string; align: 'left' | 'right' }[] = [
	{ key: 'ncalls', label: 'ncalls', align: 'right' },
	{ key: 'tottime', label: 'tottime', align: 'right' },
	{ key: 'percall', label: 'percall', align: 'right' },
	{ key: 'cumtime', label: 'cumtime', align: 'right' },
	{ key: 'cumpercall', label: 'percall', align: 'right' },
	{ key: 'location', label: 'filename:lineno(function)', align: 'left' },
];

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Outer container. */
	container: {
		...commonStyles.columnFill,
		overflow: 'hidden',
	} as CSSProperties,

	/** Toolbar with search and count. */
	toolbar: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '6px 8px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	/** Search input. */
	searchInput: {
		...commonStyles.inputField,
		width: 220,
		padding: '4px 8px',
		fontSize: 12,
	} as CSSProperties,

	/** Row count. */
	count: {
		...commonStyles.textMuted,
	} as CSSProperties,

	/** Scrollable table container. */
	tableContainer: {
		flex: 1,
		overflow: 'auto',
		background: 'var(--rr-bg-paper)',
	} as CSSProperties,

	/** Table element. */
	table: {
		width: '100%',
		borderCollapse: 'collapse',
		fontSize: 12,
		fontFamily: 'var(--rr-font-mono, monospace)',
	} as CSSProperties,

	/** Header cell. */
	th: {
		...commonStyles.tableHeader,
		position: 'sticky',
		top: 0,
		cursor: 'pointer',
		userSelect: 'none',
		whiteSpace: 'nowrap',
		background: 'var(--rr-bg-widget)',
		zIndex: 1,
	} as CSSProperties,

	/** Active sort column header. */
	thActive: {
		color: 'var(--rr-brand)',
	} as CSSProperties,

	/** Table row. */
	tr: {
		cursor: 'pointer',
	} as CSSProperties,

	/** Hovered row. */
	trHover: {
		background: 'var(--rr-bg-list-hover)',
	} as CSSProperties,

	/** Selected row (current viz root). */
	trSelected: {
		background: 'var(--rr-bg-list-active)',
		color: 'var(--rr-fg-list-active)',
	} as CSSProperties,

	/** Table body cell. */
	td: {
		...commonStyles.tableCell,
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		maxWidth: 400,
		fontSize: 12,
	} as CSSProperties,
};

// =============================================================================
// TREE FLATTENING
// =============================================================================

/**
 * Flatten a call tree into a deduplicated list of unique functions.
 * Matches snakeviz's behaviour: aggregate all occurrences of the same function.
 *
 * @param tree - Root of the call tree.
 * @returns Array of aggregated flat rows.
 */
function flattenTree(tree: ProfileTreeNode): FlatRow[] {
	const map = new Map<string, FlatRow>();

	/** Recursively walk the tree, aggregating stats by function identity. */
	function walk(node: ProfileTreeNode): void {
		if (node.name !== '<root>') {
			const key = `${node.file}:${node.line}:${node.name}`;
			const existing = map.get(key);
			if (existing) {
				// Aggregate calls and times across all call sites
				existing.ncalls += node.ncalls;
				existing.tottime += node.tottime;
				existing.cumtime += node.cumtime;
			} else {
				map.set(key, {
					name: node.name,
					file: node.file,
					line: node.line,
					ncalls: node.ncalls,
					tottime: node.tottime,
					cumtime: node.cumtime,
					percall: 0,
					cumpercall: 0,
					location: `${node.file}:${node.line}(${node.name})`,
					refNode: node,
				});
			}
		}
		for (const child of node.children) walk(child);
	}

	walk(tree);

	// Compute per-call values after aggregation
	const rows = Array.from(map.values());
	for (const row of rows) {
		row.percall = row.ncalls > 0 ? row.tottime / row.ncalls : 0;
		row.cumpercall = row.ncalls > 0 ? row.cumtime / row.ncalls : 0;
	}
	return rows;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * SnakeViz-style sortable flat statistics table.
 *
 * Column order matches pstats output: ncalls, tottime, percall, cumtime, percall,
 * filename:lineno(function).
 *
 * Row click re-roots the visualisation to that function (not just cross-highlight).
 * Table always shows all functions regardless of current viz root.
 */
/**
 * Path prefixes that identify project code.
 * Used to filter rows when showSystemCalls is false.
 */
const PROJECT_PREFIXES = [
	'./nodes/', './ai/', './lib/', './libs/', './rocketlib/', 'engLib:',
];

/** Check whether a file path belongs to project code. */
function isProjectCode(file: string): boolean {
	if (!file) return false;
	return PROJECT_PREFIXES.some((p) => file.startsWith(p));
}

const StatsTable: React.FC<{
	/** Full tree data from the server (always shows all functions). */
	treeData: ProfileTreeResponse | null;
	/** Current visualisation root node (for highlighting active row). */
	vizRoot: ProfileTreeNode | null;
	/** Callback to re-root the visualisation to a clicked function. */
	onRootChange: OnRootChange;
	/** Whether to show system/stdlib calls in the table. */
	showSystemCalls: boolean;
}> = ({ treeData, vizRoot, onRootChange, showSystemCalls }) => {
	const [sortCol, setSortCol] = useState<SortColumn>('tottime');
	const [sortDir, setSortDir] = useState<SortDir>('desc');
	const [search, setSearch] = useState('');
	const [hoveredIdx, setHoveredIdx] = useState<number>(-1);
	const [visibleCount, setVisibleCount] = useState(CHUNK_SIZE);
	const tableContainerRef = useRef<HTMLDivElement>(null);

	// =========================================================================
	// DATA PROCESSING
	// =========================================================================

	/** Flatten tree into deduplicated function list, optionally filtering system calls. */
	const allRows = useMemo(() => {
		if (!treeData?.tree) return [];
		const rows = flattenTree(treeData.tree);
		if (showSystemCalls) return rows;
		// Filter to only project code when system calls is unchecked
		return rows.filter((r) => isProjectCode(r.file));
	}, [treeData, showSystemCalls]);

	/** Apply search filter (matches snakeviz: filters by the location string). */
	const filteredRows = useMemo(() => {
		if (!search.trim()) return allRows;
		const q = search.toLowerCase().trim();
		return allRows.filter((r) => r.location.toLowerCase().includes(q));
	}, [allRows, search]);

	/** Sort by selected column. */
	const sortedRows = useMemo(() => {
		const sorted = [...filteredRows];
		const dir = sortDir === 'asc' ? 1 : -1;
		sorted.sort((a, b) => {
			const av = a[sortCol];
			const bv = b[sortCol];
			if (typeof av === 'string' && typeof bv === 'string') return dir * av.localeCompare(bv);
			return dir * ((av as number) - (bv as number));
		});
		return sorted;
	}, [filteredRows, sortCol, sortDir]);

	// Reset visible count when data changes
	useEffect(() => { setVisibleCount(CHUNK_SIZE); }, [sortedRows]);

	// =========================================================================
	// SCROLL-BASED WINDOWED RENDERING
	// =========================================================================

	const handleScroll = useCallback(() => {
		const container = tableContainerRef.current;
		if (!container) return;
		const { scrollTop, scrollHeight, clientHeight } = container;
		if (scrollHeight - scrollTop - clientHeight < 200) {
			setVisibleCount((prev) => Math.min(prev + CHUNK_SIZE, sortedRows.length));
		}
	}, [sortedRows.length]);

	// =========================================================================
	// HANDLERS
	// =========================================================================

	/** Toggle sort column/direction. */
	const handleSort = useCallback((col: SortColumn) => {
		setSortCol((prev) => {
			if (prev === col) {
				setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
				return col;
			}
			// Default to desc for numeric columns, asc for text
			setSortDir(col === 'location' ? 'asc' : 'desc');
			return col;
		});
	}, []);

	/** Row click — re-root the visualisation (snakeviz behaviour). */
	const handleRowClick = useCallback((row: FlatRow) => {
		onRootChange(row.refNode);
	}, [onRootChange]);

	/** Handle keyboard activation on a sortable column header. */
	const handleThKeyDown = useCallback((e: React.KeyboardEvent, col: SortColumn) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handleSort(col);
		}
	}, [handleSort]);

	/** Handle keyboard activation on a selectable row. */
	const handleRowKeyDown = useCallback((e: React.KeyboardEvent, row: FlatRow) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handleRowClick(row);
		}
	}, [handleRowClick]);

	// =========================================================================
	// HELPERS
	// =========================================================================

	/** Format a time value for display. */
	const fmtTime = (t: number): string => {
		if (t < 0.01) return t.toFixed(6);
		if (t < 1) return t.toFixed(4);
		return t.toFixed(2);
	};

	/** Sort indicator arrow. */
	const sortArrow = (col: SortColumn): string => {
		if (sortCol !== col) return '';
		return sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
	};

	// =========================================================================
	// RENDER
	// =========================================================================

	if (!treeData?.tree) {
		return <div style={commonStyles.empty}>No profiling data available. Start and stop a session to view stats.</div>;
	}

	const visibleRows = sortedRows.slice(0, visibleCount);

	return (
		<div style={styles.container}>
			{/* Toolbar */}
			<div style={styles.toolbar}>
				<input
					type="text"
					placeholder="Search functions..."
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					style={styles.searchInput}
				/>
				<span style={styles.count}>
					{filteredRows.length} function{filteredRows.length !== 1 ? 's' : ''}
					{search && ` (${allRows.length} total)`}
				</span>
			</div>

			{/* Table */}
			<div ref={tableContainerRef} style={styles.tableContainer} onScroll={handleScroll}>
				<table style={styles.table}>
					<thead>
						<tr>
							{COLUMNS.map((col) => (
								<th
									key={col.key}
									style={{
										...styles.th,
										textAlign: col.align,
										...(sortCol === col.key ? styles.thActive : {}),
									}}
									tabIndex={0}
									role="button"
									aria-sort={sortCol === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
									onClick={() => handleSort(col.key)}
									onKeyDown={(e) => handleThKeyDown(e, col.key)}
								>
									{col.label}{sortArrow(col.key)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{visibleRows.map((row, i) => {
							// Highlight the row that matches the current viz root
							const isSelected = vizRoot
								&& row.name === vizRoot.name
								&& row.file === vizRoot.file
								&& row.line === vizRoot.line;

							return (
								<tr
									key={`${row.file}:${row.line}:${row.name}`}
									style={{
										...styles.tr,
										...(isSelected ? styles.trSelected : {}),
										...(hoveredIdx === i && !isSelected ? styles.trHover : {}),
									}}
									tabIndex={0}
									role="row"
									onClick={() => handleRowClick(row)}
									onKeyDown={(e) => handleRowKeyDown(e, row)}
									onMouseEnter={() => setHoveredIdx(i)}
									onMouseLeave={() => setHoveredIdx(-1)}
								>
									<td style={{ ...styles.td, textAlign: 'right' }}>{row.ncalls.toLocaleString()}</td>
									<td style={{ ...styles.td, textAlign: 'right' }}>{fmtTime(row.tottime)}</td>
									<td style={{ ...styles.td, textAlign: 'right' }}>{fmtTime(row.percall)}</td>
									<td style={{ ...styles.td, textAlign: 'right' }}>{fmtTime(row.cumtime)}</td>
									<td style={{ ...styles.td, textAlign: 'right' }}>{fmtTime(row.cumpercall)}</td>
									<td style={{ ...styles.td, textAlign: 'left' }}>{row.location}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
};

export default StatsTable;
