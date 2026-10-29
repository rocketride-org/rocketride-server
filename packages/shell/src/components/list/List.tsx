// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * List — rows with a primary line, an optional secondary line, a leading
 * icon or avatar and trailing meta: members, recent runs, connections,
 * settings categories.
 *
 * Static by default (a plain `<ul>`). Passing `onSelect` makes it a
 * single-select WAI-ARIA listbox: one Tab stop, Arrow Up/Down and Home/End
 * move, typing jumps to a row, Enter/Space select, and the selected row is
 * highlighted. For tree-shaped data use Tree; for columns use Table.
 *
 * Built on `.rr-list` from components.css.
 */

import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { findTypeaheadIndex, getFirstIndex, getLastIndex, getNextIndex } from '../overlay/listNavigation';
import { isTypeaheadKey, useTypeahead } from '../overlay/overlayHooks';

// =============================================================================
// TYPES
// =============================================================================

/** One row of a {@link List}. */
export interface IListItem {
	/** Stable id, passed to `onSelect`. */
	id: string;
	/** Main line. Also used for typeahead. */
	primary: string;
	/** Second, quieter line. */
	secondary?: ReactNode;
	/** Leading icon or Avatar. */
	leading?: ReactNode;
	/** Trailing meta: a timestamp, a badge, a count. */
	trailing?: ReactNode;
	/** Not selectable (selectable lists only). */
	disabled?: boolean;
}

/** Props for the {@link List} component. */
export interface IListProps {
	/** Rows, in order. */
	items: IListItem[];
	/** Make the list selectable; fired with the chosen row id. */
	onSelect?: (id: string) => void;
	/** The selected row id (selectable lists). */
	selectedId?: string | null;
	/** Hairline between rows. */
	dividers?: boolean;
	/** Tighter row padding. */
	dense?: boolean;
	/** Accessible name (required for selectable lists). */
	ariaLabel?: string;
	/** Shown when there are no rows. Defaults to `'Nothing here yet'`. */
	emptyText?: ReactNode;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a static or selectable list.
 *
 * @param props - {@link IListProps}.
 * @returns The list element.
 */
export function List({ items, onSelect, selectedId = null, dividers = false, dense = false, ariaLabel, emptyText = 'Nothing here yet' }: IListProps): React.ReactElement {
	const isSelectable = Boolean(onSelect);
	const selectedIndex = items.findIndex((item) => item.id === selectedId);
	const [focusIndex, setFocusIndex] = useState(-1);
	const rowRefs = useRef<(HTMLLIElement | null)[]>([]);
	const typeahead = useTypeahead();
	const isFocusPendingRef = useRef(false);

	// The tab stop: the focused row, else the selected row, else the first.
	let tabIndex = focusIndex;
	if (tabIndex < 0) tabIndex = selectedIndex;
	if (tabIndex < 0 || items[tabIndex]?.disabled) tabIndex = getFirstIndex(items);

	// Move real focus after keyboard navigation.
	useEffect(() => {
		if (!isFocusPendingRef.current || focusIndex < 0) return;
		isFocusPendingRef.current = false;
		rowRefs.current[focusIndex]?.focus();
	}, [focusIndex]);

	/** Moves focus to a row from the keyboard. */
	function moveTo(index: number): void {
		if (index < 0) return;
		isFocusPendingRef.current = true;
		setFocusIndex(index);
	}

	/** Keyboard handling for selectable lists. */
	function handleKeyDown(event: React.KeyboardEvent, index: number): void {
		const item = items[index];
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveTo(getNextIndex(items, index, 1));
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveTo(getNextIndex(items, index, -1));
			return;
		}
		if (event.key === 'Home') {
			event.preventDefault();
			moveTo(getFirstIndex(items));
			return;
		}
		if (event.key === 'End') {
			event.preventDefault();
			moveTo(getLastIndex(items));
			return;
		}
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			if (!item.disabled) onSelect?.(item.id);
			return;
		}
		if (isTypeaheadKey(event)) {
			const labels = items.map((row) => row.primary);
			moveTo(findTypeaheadIndex(labels, items, typeahead(event.key), index));
		}
	}

	let listClassName = 'rr-list';
	if (dividers) listClassName += ' rr-list--dividers';
	if (dense) listClassName += ' rr-list--dense';

	if (items.length === 0) {
		return <div className="rr-list__empty">{emptyText}</div>;
	}

	if (!isSelectable) {
		return (
			<ul className={listClassName} aria-label={ariaLabel}>
				{items.map((item) => (
					<li key={item.id} className="rr-list__row">
						<ListRowContent item={item} />
					</li>
				))}
			</ul>
		);
	}

	return (
		<ul className={`${listClassName} rr-list--selectable`} role="listbox" aria-label={ariaLabel}>
			{items.map((item, index) => (
				<li
					key={item.id}
					ref={(element) => {
						rowRefs.current[index] = element;
					}}
					role="option"
					className="rr-list__row"
					aria-selected={item.id === selectedId}
					aria-disabled={item.disabled || undefined}
					tabIndex={index === tabIndex ? 0 : -1}
					onFocus={() => setFocusIndex(index)}
					onClick={() => {
						if (!item.disabled) onSelect?.(item.id);
					}}
					onKeyDown={(event) => handleKeyDown(event, index)}
				>
					<ListRowContent item={item} />
				</li>
			))}
		</ul>
	);
}

/**
 * The inside of a row: leading, text lines, trailing.
 *
 * @param props - The row.
 * @returns The row content.
 */
function ListRowContent({ item }: { item: IListItem }): React.ReactElement {
	return (
		<>
			{item.leading && <span className="rr-list__leading">{item.leading}</span>}
			<span className="rr-list__text">
				<span className="rr-list__primary rr-truncate">{item.primary}</span>
				{item.secondary && <span className="rr-list__secondary rr-truncate">{item.secondary}</span>}
			</span>
			{item.trailing && <span className="rr-list__trailing">{item.trailing}</span>}
		</>
	);
}
