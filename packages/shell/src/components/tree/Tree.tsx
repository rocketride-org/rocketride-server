// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Tree — hierarchical data as an expandable outline: pipeline components by
 * lane, nested settings, schema fields, org > team > member. (Explorer and
 * DocExplorer remain the file-system trees; Tree is the generic one.)
 *
 * Follows the WAI-ARIA tree view pattern with a single Tab stop:
 *   Up / Down        previous / next visible node
 *   Right            expand a closed parent, or enter an open one
 *   Left             collapse an open parent, or go to the parent
 *   Home / End       first / last visible node
 *   Enter / Space    select
 *   *                expand every sibling of the focused node
 *   typing           jump to the next node starting with the typed text
 *
 * Clicking a row selects it and toggles it when it has children. Rows render
 * flat with aria-level / aria-setsize / aria-posinset, so deep trees stay
 * cheap. Expansion is controlled (`expanded` + `onExpandedChange`) or
 * uncontrolled (`defaultExpanded`).
 *
 * Built on `.rr-tree` from components.css.
 */

import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { isTypeaheadKey, useTypeahead } from '../overlay/overlayHooks';
import { findTypeaheadIndex } from '../overlay/listNavigation';

// =============================================================================
// TYPES
// =============================================================================

/** One node of a {@link Tree}. */
export interface ITreeNode {
	/** Stable id, unique across the whole tree. */
	id: string;
	/** Row text. Also used for typeahead. */
	label: string;
	/** Leading icon. */
	icon?: ReactNode;
	/** Trailing meta: a count, a status dot. */
	meta?: ReactNode;
	/** Child nodes; present (even empty) = expandable. */
	children?: ITreeNode[];
	/** Not selectable (still focusable and expandable). */
	disabled?: boolean;
}

/** A visible node with its position, as rendered. */
export interface IFlatTreeNode {
	node: ITreeNode;
	/** 1-based depth (aria-level). */
	level: number;
	/** The parent's id, or null at the root. */
	parentId: string | null;
	/** Whether the node can expand. */
	hasChildren: boolean;
	/** Whether it is currently expanded. */
	isExpanded: boolean;
	/** 1-based position among its siblings (aria-posinset). */
	posInSet: number;
	/** Number of siblings including itself (aria-setsize). */
	setSize: number;
}

/** Props for the {@link Tree} component. */
export interface ITreeProps {
	/** Root nodes. */
	nodes: ITreeNode[];
	/** Accessible name (required: a tree must be named). */
	ariaLabel: string;
	/** Expanded node ids (controlled). */
	expanded?: string[];
	/** Initially expanded node ids (uncontrolled). */
	defaultExpanded?: string[];
	/** Fired with the new expanded ids. */
	onExpandedChange?: (expanded: string[]) => void;
	/** Selected node id. */
	selectedId?: string | null;
	/** Fired with the chosen node id. */
	onSelect?: (id: string) => void;
	/** Tighter rows. */
	dense?: boolean;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Flattens the visible part of a tree: every root, plus the children of
 * expanded nodes, in display order.
 *
 * @param nodes - Root nodes.
 * @param expanded - Expanded node ids.
 * @returns The visible nodes with level, parent and set position.
 */
export function flattenVisible(nodes: readonly ITreeNode[], expanded: ReadonlySet<string>): IFlatTreeNode[] {
	const result: IFlatTreeNode[] = [];

	/** Appends one sibling set and recurses into expanded parents. */
	function visit(siblings: readonly ITreeNode[], level: number, parentId: string | null): void {
		siblings.forEach((node, index) => {
			const hasChildren = node.children !== undefined;
			const isExpanded = hasChildren && expanded.has(node.id);
			result.push({ node, level, parentId, hasChildren, isExpanded, posInSet: index + 1, setSize: siblings.length });
			if (isExpanded && node.children) visit(node.children, level + 1, node.id);
		});
	}

	visit(nodes, 1, null);
	return result;
}

/**
 * Ids of every expandable sibling of a node (for the `*` key).
 *
 * @param flat - The visible nodes.
 * @param index - The focused node's index.
 * @returns Ids of expandable nodes sharing its parent.
 */
export function expandableSiblingIds(flat: readonly IFlatTreeNode[], index: number): string[] {
	const parentId = flat[index].parentId;
	return flat.filter((entry) => entry.parentId === parentId && entry.hasChildren).map((entry) => entry.node.id);
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a keyboard-navigable tree.
 *
 * @param props - {@link ITreeProps}.
 * @returns The tree element.
 */
export function Tree({ nodes, ariaLabel, expanded, defaultExpanded = [], onExpandedChange, selectedId = null, onSelect, dense = false }: ITreeProps): React.ReactElement {
	const [internalExpanded, setInternalExpanded] = useState<string[]>(defaultExpanded);
	const [focusId, setFocusId] = useState<string | null>(null);
	const rowRefs = useRef(new Map<string, HTMLLIElement>());
	const isFocusPendingRef = useRef(false);
	const typeahead = useTypeahead();

	let expandedIds = internalExpanded;
	if (expanded !== undefined) expandedIds = expanded;
	const flat = flattenVisible(nodes, new Set(expandedIds));

	// The single tab stop: the focused node if still visible, else the
	// selected node, else the first.
	let tabStopIndex = flat.findIndex((entry) => entry.node.id === focusId);
	if (tabStopIndex < 0) tabStopIndex = flat.findIndex((entry) => entry.node.id === selectedId);
	if (tabStopIndex < 0) tabStopIndex = 0;

	useEffect(() => {
		if (!isFocusPendingRef.current || !focusId) return;
		isFocusPendingRef.current = false;
		rowRefs.current.get(focusId)?.focus();
	}, [focusId]);

	/** Replaces the expanded set and reports it. */
	function setExpanded(next: string[]): void {
		if (expanded === undefined) setInternalExpanded(next);
		onExpandedChange?.(next);
	}

	/** Opens or closes one node. */
	function toggle(id: string, isOpen: boolean): void {
		const isCurrentlyOpen = expandedIds.includes(id);
		if (isOpen && !isCurrentlyOpen) setExpanded([...expandedIds, id]);
		if (!isOpen && isCurrentlyOpen) setExpanded(expandedIds.filter((openId) => openId !== id));
	}

	/** Moves focus to a visible node from the keyboard. */
	function focusIndex(index: number): void {
		const entry = flat[index];
		if (!entry) return;
		isFocusPendingRef.current = true;
		setFocusId(entry.node.id);
	}

	/** Selects a node unless it is disabled. */
	function select(entry: IFlatTreeNode): void {
		if (entry.node.disabled) return;
		onSelect?.(entry.node.id);
	}

	/** The full tree keyboard model. */
	function handleKeyDown(event: React.KeyboardEvent, index: number): void {
		const entry = flat[index];
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			focusIndex(Math.min(index + 1, flat.length - 1));
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			focusIndex(Math.max(index - 1, 0));
			return;
		}
		if (event.key === 'ArrowRight') {
			event.preventDefault();
			if (!entry.hasChildren) return;
			if (!entry.isExpanded) {
				toggle(entry.node.id, true);
				return;
			}
			if (flat[index + 1]?.parentId === entry.node.id) focusIndex(index + 1);
			return;
		}
		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			if (entry.isExpanded) {
				toggle(entry.node.id, false);
				return;
			}
			const parentIndex = flat.findIndex((candidate) => candidate.node.id === entry.parentId);
			if (parentIndex >= 0) focusIndex(parentIndex);
			return;
		}
		if (event.key === 'Home') {
			event.preventDefault();
			focusIndex(0);
			return;
		}
		if (event.key === 'End') {
			event.preventDefault();
			focusIndex(flat.length - 1);
			return;
		}
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			select(entry);
			return;
		}
		if (event.key === '*') {
			event.preventDefault();
			const siblings = expandableSiblingIds(flat, index).filter((id) => !expandedIds.includes(id));
			if (siblings.length > 0) setExpanded([...expandedIds, ...siblings]);
			return;
		}
		if (isTypeaheadKey(event)) {
			const labels = flat.map((candidate) => candidate.node.label);
			const items = flat.map(() => ({}));
			const match = findTypeaheadIndex(labels, items, typeahead(event.key), index);
			if (match >= 0) focusIndex(match);
		}
	}

	let treeClassName = 'rr-tree';
	if (dense) treeClassName += ' rr-tree--dense';

	return (
		<ul className={treeClassName} role="tree" aria-label={ariaLabel}>
			{flat.map((entry, index) => {
				const { node } = entry;
				let tabIndex = -1;
				if (index === tabStopIndex) tabIndex = 0;
				let ariaExpanded: boolean | undefined;
				if (entry.hasChildren) ariaExpanded = entry.isExpanded;

				return (
					<li
						key={node.id}
						ref={(element) => {
							if (element) {
								rowRefs.current.set(node.id, element);
							} else {
								rowRefs.current.delete(node.id);
							}
						}}
						role="treeitem"
						className="rr-tree__row"
						aria-level={entry.level}
						aria-setsize={entry.setSize}
						aria-posinset={entry.posInSet}
						aria-expanded={ariaExpanded}
						aria-selected={node.id === selectedId}
						aria-disabled={node.disabled || undefined}
						tabIndex={tabIndex}
						style={{ '--rr-tree-level': entry.level - 1 } as React.CSSProperties}
						onFocus={(event) => {
							if (event.target === event.currentTarget) setFocusId(node.id);
						}}
						onClick={() => {
							select(entry);
							if (entry.hasChildren) toggle(node.id, !entry.isExpanded);
						}}
						onKeyDown={(event) => handleKeyDown(event, index)}
					>
						<span className="rr-tree__chevron" data-expandable={entry.hasChildren || undefined} aria-hidden="true" />
						{node.icon && <span className="rr-tree__icon">{node.icon}</span>}
						<span className="rr-tree__label rr-truncate">{node.label}</span>
						{node.meta && <span className="rr-tree__meta">{node.meta}</span>}
					</li>
				);
			})}
		</ul>
	);
}
