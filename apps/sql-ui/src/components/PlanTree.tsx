// =============================================================================
// MIT License
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
// SQL-UI — PLAN TREE (the interpreted view of a plain EXPLAIN result)
// =============================================================================
//
// Renders a parsed plan as an ARIA tree: one row per plan node, the planner's
// own label and field names verbatim, and a right-hand notes column holding
// rule-based observations.
//
// HONESTY RULES THIS COMPONENT ENFORCES:
//  - Every numeric planner value is suffixed ` est.` — these are estimates the
//    planner made, never measurements of a run (plain EXPLAIN does not run the
//    statement).
//  - No cost bars, no width-as-magnitude, no colour as meaning. A reader who
//    cannot see colour loses nothing: every state carries text.
//  - Notes are labelled `detected by pattern` and cite the exact field they
//    read, because they are text rules over planner output, not a cost model.
// =============================================================================

import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { StatusBadge } from 'shell';
import type { IPlanNode } from '../sql/explain';
import { planNotes } from '../sql/explain';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link PlanTree} component. */
export interface IPlanTreeProps {
	/** The parsed plan's root node. */
	root: IPlanNode;
}

/** One flattened, currently visible tree row. */
interface IFlatRow {
	/** Stable identity: the node's path through the tree (`0.2.1`). */
	id: string;
	/** The node this row draws. */
	node: IPlanNode;
	/** ARIA level, 1-based. */
	level: number;
	/** Id of the row's parent (null at the root). */
	parentId: string | null;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	tree: {
		fontSize: 12.5,
		outline: 'none',
	} as CSSProperties,

	row: (focused: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'flex-start',
		gap: 12,
		padding: '6px 8px',
		borderBottom: '1px solid var(--rr-bg-widget)',
		background: focused ? 'var(--rr-bg-list-hover)' : 'transparent',
		cursor: 'default',
		outline: 'none',
	}),

	main: (level: number): CSSProperties => ({
		flex: 1,
		minWidth: 0,
		// Indentation carries depth visually; aria-level carries it for AT.
		paddingLeft: (level - 1) * 16,
	}),

	// The expand/collapse affordance is text, never a colour or a bare glyph.
	twisty: {
		display: 'inline-block',
		width: 14,
		color: 'var(--rr-text-secondary)',
		fontFamily: 'var(--rr-font-mono, monospace)',
	} as CSSProperties,

	label: {
		fontFamily: 'var(--rr-font-mono, monospace)',
		color: 'var(--rr-text-primary)',
		fontWeight: 600,
	} as CSSProperties,

	fields: {
		display: 'flex',
		flexWrap: 'wrap' as const,
		gap: '2px 14px',
		marginTop: 3,
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	notesColumn: {
		width: 230,
		flexShrink: 0,
		display: 'flex',
		flexDirection: 'column' as const,
		gap: 4,
	} as CSSProperties,

	note: {
		fontSize: 11.5,
		lineHeight: 1.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	noteEvidence: {
		fontFamily: 'var(--rr-font-mono, monospace)',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	notesHeader: {
		width: 230,
		flexShrink: 0,
		fontSize: 11,
		textTransform: 'uppercase' as const,
		letterSpacing: '0.04em',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	headerRow: {
		display: 'flex',
		gap: 12,
		padding: '0 8px 6px',
		borderBottom: '1px solid var(--rr-bg-widget)',
	} as CSSProperties,
};

// =============================================================================
// FLATTENING
// =============================================================================

/**
 * Flatten the visible part of the tree into rows, depth-first.
 *
 * Collapsed nodes keep their subtree out of the row list entirely, so arrow
 * navigation never lands on a row the reader cannot see.
 *
 * @param node - The node to walk.
 * @param id - The node's path id.
 * @param level - The node's 1-based ARIA level.
 * @param parentId - The parent's path id (null at the root).
 * @param collapsed - The set of collapsed node ids.
 * @param out - The accumulating row list.
 */
function flatten(node: IPlanNode, id: string, level: number, parentId: string | null, collapsed: Set<string>, out: IFlatRow[]): void {
	out.push({ id, node, level, parentId });
	if (collapsed.has(id)) return;
	node.children.forEach((child, i) => flatten(child, `${id}.${i}`, level + 1, id, collapsed, out));
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The interpreted plan view: an ARIA tree of plan nodes with their planner
 * fields and pattern-detected notes.
 *
 * Keyboard: ↑/↓ move between visible rows, → expands a collapsed row (or steps
 * into the first child), ← collapses an expanded row (or steps out to the
 * parent). Focus is roving — exactly one row is tabbable at a time.
 */
export const PlanTree: React.FC<IPlanTreeProps> = ({ root }) => {
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
	const [focusedId, setFocusedId] = useState('0');
	const rowRefs = useRef(new Map<string, HTMLDivElement>());

	const rows = useMemo<IFlatRow[]>(() => {
		const out: IFlatRow[] = [];
		flatten(root, '0', 1, null, collapsed, out);
		return out;
	}, [root, collapsed]);

	// A collapse can hide the focused row; fall back to the root rather than
	// leaving focus on a row that is no longer in the list.
	const activeId = rows.some((r) => r.id === focusedId) ? focusedId : '0';

	/**
	 * Move focus to a row and put the DOM focus there too.
	 *
	 * @param id - The row id to focus.
	 */
	const focusRow = useCallback((id: string): void => {
		setFocusedId(id);
		rowRefs.current.get(id)?.focus();
	}, []);

	/**
	 * Expand or collapse one row.
	 *
	 * @param id - The row id.
	 * @param next - True to collapse, false to expand.
	 */
	const setCollapsedFor = useCallback((id: string, next: boolean): void => {
		setCollapsed((prev) => {
			const copy = new Set(prev);
			if (next) copy.add(id); else copy.delete(id);
			return copy;
		});
	}, []);

	/**
	 * Tree keyboard model (WAI-ARIA tree pattern, vertical orientation).
	 *
	 * @param e - The keyboard event.
	 * @param row - The row the event came from.
	 */
	const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>, row: IFlatRow): void => {
		const index = rows.findIndex((r) => r.id === row.id);
		const hasChildren = row.node.children.length > 0;
		const isCollapsed = collapsed.has(row.id);
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				if (index < rows.length - 1) focusRow(rows[index + 1].id);
				break;
			case 'ArrowUp':
				e.preventDefault();
				if (index > 0) focusRow(rows[index - 1].id);
				break;
			case 'ArrowRight':
				e.preventDefault();
				if (hasChildren && isCollapsed) setCollapsedFor(row.id, false);
				else if (hasChildren && index < rows.length - 1) focusRow(rows[index + 1].id);
				break;
			case 'ArrowLeft':
				e.preventDefault();
				if (hasChildren && !isCollapsed) setCollapsedFor(row.id, true);
				else if (row.parentId) focusRow(row.parentId);
				break;
			case 'Home':
				e.preventDefault();
				focusRow(rows[0].id);
				break;
			case 'End':
				e.preventDefault();
				focusRow(rows[rows.length - 1].id);
				break;
			default:
				break;
		}
	}, [rows, collapsed, focusRow, setCollapsedFor]);

	return (
		<div>
			<div style={styles.headerRow}>
				<div style={{ flex: 1 }} />
				<div style={styles.notesHeader}>Notes · detected by pattern</div>
			</div>
			<div role="tree" aria-label="Query plan" style={styles.tree}>
				{rows.map((row) => {
					const hasChildren = row.node.children.length > 0;
					const isCollapsed = collapsed.has(row.id);
					const notes = planNotes(row.node);
					return (
						<div
							key={row.id}
							role="treeitem"
							aria-level={row.level}
							aria-expanded={hasChildren ? !isCollapsed : undefined}
							aria-selected={row.id === activeId}
							tabIndex={row.id === activeId ? 0 : -1}
							ref={(el) => {
								if (el) rowRefs.current.set(row.id, el);
								else rowRefs.current.delete(row.id);
							}}
							style={styles.row(row.id === activeId)}
							onKeyDown={(e) => onKeyDown(e, row)}
							onFocus={() => setFocusedId(row.id)}
							onClick={() => { if (hasChildren) setCollapsedFor(row.id, !isCollapsed); }}
						>
							<div style={styles.main(row.level)}>
								<div>
									<span style={styles.twisty} aria-hidden="true">{hasChildren ? (isCollapsed ? '+' : '−') : ''}</span>
									<span style={styles.label}>{row.node.label}</span>
								</div>
								{row.node.fields.length > 0 && (
									<div style={styles.fields}>
										{row.node.fields.map((f) => (
											// `est.` marks a planner estimate — plain EXPLAIN measures nothing.
											<span key={f.key}>{f.key}: {f.value}{f.numeric ? ' est.' : ''}</span>
										))}
									</div>
								)}
							</div>
							<div style={styles.notesColumn}>
								{notes.map((note) => (
									<div key={note.evidence} style={styles.note}>
										<StatusBadge variant="muted">heuristic</StatusBadge>{' '}
										<span style={styles.noteEvidence}>{note.evidence}</span>: {note.text}
									</div>
								))}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
};

export default PlanTree;
