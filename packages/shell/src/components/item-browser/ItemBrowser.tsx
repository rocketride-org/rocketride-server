// =============================================================================
// ITEM BROWSER — the middle of a desktop file browser: icons or details
// =============================================================================
// Two views over the same items, the way every OS file browser has them:
//
//   grid — large icon tiles, optionally in labelled sections ("Folders",
//          "Files")
//   list — a details table with sortable column headers
//
// Both share the desktop rules people already know: click selects one,
// Ctrl/Cmd+click toggles, Shift+click selects a run, double-click or Enter
// opens, arrow keys move (Shift extends), Ctrl/Cmd+A selects everything,
// clicking empty space clears the selection, dragging across empty space
// draws a box that selects what it touches, right-click asks for a context
// menu, and selected items drag onto the items the caller accepts as drop
// targets (folders). Items and order come from the caller (sorting
// included); the browser only renders, selects and reports.
// =============================================================================

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ITableColumn, ITableSort } from '../table/Table';
import { nextSort } from '../table/Table';
import { indexAfterKey, mergeSelection, rectsIntersect, selectionAfterClick } from './selection';
import type { IBrowserRect, ISelectionModifiers } from './selection';

/** One file, folder or other item in an {@link ItemBrowser}. */
export interface IBrowserItem {
	/** Stable id. */
	id: string;
	/** Display name. */
	name: string;
	/** Large icon for the grid; the list shows it small beside the name. */
	icon: ReactNode;
	/** Second line under the name in the grid, e.g. "57 files". */
	detail?: ReactNode;
	/** Section label in the grid, e.g. "Folders" or "Files". */
	section?: string;
}

/** A screen point, for placing a context menu. */
export interface IBrowserPoint {
	x: number;
	y: number;
}

/** How an {@link ItemBrowser} shows its items. */
export type ItemBrowserView = 'grid' | 'list';

/** Props for the {@link ItemBrowser} component. */
export interface IItemBrowserProps<T extends IBrowserItem> {
	/** Items, in display order (sorted by the caller). */
	items: T[];
	/** Icons or details. */
	view: ItemBrowserView;
	/** Details columns after Name, for the list view. */
	columns?: ITableColumn<T>[];
	/** Name column header. Defaults to "Name". */
	nameHeader?: ReactNode;
	/** The active sort; headers of columns with `sortable` report clicks through `onSortChange`. The name column's id is "name". */
	sort?: ITableSort | null;
	/** Fired with the next sort when a sortable header is clicked. */
	onSortChange?: (sort: ITableSort) => void;
	/** Selected item ids (controlled). */
	selectedIds: string[];
	/** Fired with the new selection. */
	onSelectionChange: (ids: string[]) => void;
	/** Opens an item: double-click or Enter. */
	onOpen: (item: T) => void;
	/** Right-click on an item (which is selected first) or, with null, on empty space. */
	onContextMenu?: (item: T | null, point: IBrowserPoint) => void;
	/** Accessible name. */
	ariaLabel: string;
	/** Shown when there are no items. */
	emptyText?: ReactNode;
	/**
	 * Drops dragged items onto an item. When set, items can be dragged: a drag
	 * carries the selection (the pressed item is selected first if it was not).
	 */
	onDropItems?: (draggedIds: string[], target: T) => void;
	/** Whether an item accepts a drop of these items. Defaults to never. */
	canDropOn?: (target: T, draggedIds: string[]) => boolean;
	/** Fired when a drag of items starts, so drop targets outside the browser can accept them. */
	onItemsDragStart?: (draggedIds: string[]) => void;
	/** Fired when that drag ends, dropped or not. */
	onItemsDragEnd?: () => void;
}

/** Pointer travel, in px, before a press on empty space becomes a selection box. */
const BOX_THRESHOLD = 4;

type ItemProps = React.HTMLAttributes<HTMLElement> & { 'data-item-id': string };

/**
 * Renders the items as icon tiles or as a details list.
 *
 * @param props - {@link IItemBrowserProps}.
 * @returns The browser element.
 */
export function ItemBrowser<T extends IBrowserItem>({ items, view, columns = [], nameHeader = 'Name', sort = null, onSortChange, selectedIds, onSelectionChange, onOpen, onContextMenu, ariaLabel, emptyText = 'This folder is empty.', onDropItems, canDropOn, onItemsDragStart, onItemsDragEnd }: IItemBrowserProps<T>): React.ReactElement {
	const rootRef = useRef<HTMLDivElement>(null);
	const [anchorId, setAnchorId] = useState<string | null>(null);
	const [focusId, setFocusId] = useState<string | null>(null);
	const [box, setBox] = useState<IBrowserRect | null>(null);
	const [draggedIds, setDraggedIds] = useState<string[]>([]);
	const [dropTargetId, setDropTargetId] = useState<string | null>(null);
	// A box drag ends with a click on empty space; that click must not clear the box's selection.
	const isClickSuppressedRef = useRef(false);
	const boxCleanupRef = useRef<(() => void) | null>(null);
	const orderedIds = items.map((item) => item.id);
	const isDraggable = Boolean(onDropItems);

	// Keep the focused item's element focused after keyboard moves.
	useLayoutEffect(() => {
		if (!focusId || !rootRef.current) return;
		if (!rootRef.current.contains(document.activeElement)) return;
		const element = rootRef.current.querySelector<HTMLElement>(`[data-item-id="${cssEscape(focusId)}"]`);
		element?.focus();
	}, [focusId]);

	// A box drag in progress when the browser unmounts must not leave listeners behind.
	useEffect(() => {
		return () => boxCleanupRef.current?.();
	}, []);

	/** Applies a click with its modifiers. */
	function select(id: string, modifiers: ISelectionModifiers): void {
		const next = selectionAfterClick(orderedIds, { selectedIds, anchorId }, id, modifiers);
		setAnchorId(next.anchorId);
		setFocusId(id);
		onSelectionChange(next.selectedIds);
	}

	function handleKeyDown(event: React.KeyboardEvent): void {
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
			event.preventDefault();
			onSelectionChange(orderedIds);
			return;
		}
		const focusIndex = orderedIds.indexOf(focusId ?? '');
		if (event.key === 'Enter' && focusIndex >= 0) {
			event.preventDefault();
			onOpen(items[focusIndex]);
			return;
		}
		if (event.key === ' ' && focusIndex >= 0) {
			event.preventDefault();
			select(orderedIds[focusIndex], { isToggle: event.ctrlKey || event.metaKey, isRange: event.shiftKey });
			return;
		}
		const next = indexAfterKey(event.key, focusIndex, items.length, columnCount(rootRef.current, view));
		if (next === null) return;
		event.preventDefault();
		select(orderedIds[next], { isToggle: false, isRange: event.shiftKey });
	}

	/** A press on empty space starts a selection box; Ctrl/Cmd or Shift adds to the selection. */
	function handleMouseDown(event: React.MouseEvent): void {
		if (event.button !== 0) return;
		const target = event.target as HTMLElement;
		if (target.closest('[data-item-id], button, input, a, th')) return;
		const start = { x: event.clientX, y: event.clientY };
		let base: string[] = [];
		if (event.ctrlKey || event.metaKey || event.shiftKey) base = selectedIds;
		let isBoxing = false;
		const move = (moveEvent: MouseEvent) => {
			const width = Math.abs(moveEvent.clientX - start.x);
			const height = Math.abs(moveEvent.clientY - start.y);
			if (!isBoxing && width < BOX_THRESHOLD && height < BOX_THRESHOLD) return;
			isBoxing = true;
			moveEvent.preventDefault();
			const rect = { left: Math.min(start.x, moveEvent.clientX), top: Math.min(start.y, moveEvent.clientY), width, height };
			setBox(rect);
			onSelectionChange(mergeSelection(orderedIds, base, idsInRect(rootRef.current, rect)));
		};
		const end = () => {
			window.removeEventListener('mousemove', move);
			window.removeEventListener('mouseup', end);
			boxCleanupRef.current = null;
			setBox(null);
			if (isBoxing) isClickSuppressedRef.current = true;
		};
		window.addEventListener('mousemove', move);
		window.addEventListener('mouseup', end);
		boxCleanupRef.current = end;
	}

	function handleBackgroundClick(): void {
		if (isClickSuppressedRef.current) {
			isClickSuppressedRef.current = false;
			return;
		}
		onSelectionChange([]);
	}

	function handleBackgroundContextMenu(event: React.MouseEvent): void {
		if (!onContextMenu) return;
		event.preventDefault();
		onSelectionChange([]);
		onContextMenu(null, { x: event.clientX, y: event.clientY });
	}

	/** Ends a drag of items, dropped or not. */
	function finishDrag(): void {
		setDraggedIds([]);
		setDropTargetId(null);
		onItemsDragEnd?.();
	}

	/** Everything an item element needs: state, focus, selection, opening, context menu and drag and drop. */
	function itemProps(item: T, baseClass: string): ItemProps {
		const isSelected = selectedIds.includes(item.id);
		let className = baseClass;
		if (isSelected) className += ` ${baseClass}--selected`;
		if (draggedIds.includes(item.id)) className += ` ${baseClass}--dragging`;
		if (dropTargetId === item.id) className += ` ${baseClass}--drop-target`;
		let tabIndex = -1;
		if (item.id === tabStopId) tabIndex = 0;
		const props: ItemProps = {
			'data-item-id': item.id,
			'aria-selected': isSelected,
			tabIndex,
			className,
			onClick: (event) => {
				event.stopPropagation();
				select(item.id, { isToggle: event.ctrlKey || event.metaKey, isRange: event.shiftKey });
			},
			onDoubleClick: () => onOpen(item),
			onContextMenu: (event) => {
				if (!onContextMenu) return;
				event.preventDefault();
				event.stopPropagation();
				if (!selectedIds.includes(item.id)) select(item.id, { isToggle: false, isRange: false });
				onContextMenu(item, { x: event.clientX, y: event.clientY });
			},
			onFocus: () => setFocusId(item.id),
		};
		if (!isDraggable) return props;
		const isAcceptedDrop = () => draggedIds.length > 0 && !draggedIds.includes(item.id) && Boolean(canDropOn?.(item, draggedIds));
		props.draggable = true;
		props.onDragStart = (event) => {
			let ids = selectedIds;
			if (!selectedIds.includes(item.id)) {
				ids = [item.id];
				select(item.id, { isToggle: false, isRange: false });
			}
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', ids.join('\n'));
			if (ids.length > 1) setCountDragImage(event, ids.length);
			setDraggedIds(ids);
			onItemsDragStart?.(ids);
		};
		props.onDragEnd = finishDrag;
		props.onDragOver = (event) => {
			if (!isAcceptedDrop()) return;
			event.preventDefault();
			event.stopPropagation();
			event.dataTransfer.dropEffect = 'move';
			if (dropTargetId !== item.id) setDropTargetId(item.id);
		};
		props.onDragLeave = (event) => {
			if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
			if (dropTargetId === item.id) setDropTargetId(null);
		};
		props.onDrop = (event) => {
			if (!isAcceptedDrop()) return;
			event.preventDefault();
			event.stopPropagation();
			const ids = draggedIds;
			finishDrag();
			onDropItems?.(ids, item);
		};
		return props;
	}

	// One item takes the tab stop: the focused one, else the first selected, else the first.
	let tabStopId = focusId;
	if (!tabStopId || !orderedIds.includes(tabStopId)) tabStopId = selectedIds[0] ?? orderedIds[0] ?? null;

	let body: ReactNode = <div className="rr-item-browser__empty">{emptyText}</div>;
	if (items.length > 0 && view === 'grid') body = <GridView items={items} ariaLabel={ariaLabel} itemProps={itemProps} />;
	if (items.length > 0 && view === 'list') body = <ListView items={items} ariaLabel={ariaLabel} itemProps={itemProps} columns={columns} nameHeader={nameHeader} sort={sort} onSortChange={onSortChange} />;

	let rootClassName = `rr-item-browser rr-item-browser--${view}`;
	if (box) rootClassName += ' rr-item-browser--boxing';

	return (
		<div ref={rootRef} className={rootClassName} onMouseDown={handleMouseDown} onClick={handleBackgroundClick} onContextMenu={handleBackgroundContextMenu} onKeyDown={handleKeyDown}>
			{body}
			{box && <div className="rr-item-browser__box" style={{ left: box.left, top: box.top, width: box.width, height: box.height }} aria-hidden="true" />}
		</div>
	);
}

// =============================================================================
// VIEWS
// =============================================================================

interface IViewProps<T extends IBrowserItem> {
	items: T[];
	ariaLabel: string;
	itemProps: (item: T, baseClass: string) => ItemProps;
}

/** Icon tiles, grouped into labelled sections when items carry one. */
function GridView<T extends IBrowserItem>({ items, ariaLabel, itemProps }: IViewProps<T>): React.ReactElement {
	const sections = groupBySection(items);
	return (
		<div role="listbox" aria-label={ariaLabel} aria-multiselectable="true" className="rr-item-browser__sections">
			{sections.map((section) => (
				<div key={section.label} role="group" aria-label={section.label || undefined} className="rr-item-browser__section">
					{section.label && <div className="rr-item-browser__section-label">{section.label}</div>}
					<div className="rr-item-browser__grid">
						{section.items.map((item) => (
							<div key={item.id} role="option" title={item.name} {...itemProps(item, 'rr-item-browser__tile')}>
								<span className="rr-item-browser__tile-icon" aria-hidden="true">
									{item.icon}
								</span>
								<span className="rr-item-browser__tile-name">{item.name}</span>
								{item.detail && <span className="rr-item-browser__tile-detail">{item.detail}</span>}
							</div>
						))}
					</div>
				</div>
			))}
		</div>
	);
}

interface IListViewProps<T extends IBrowserItem> extends IViewProps<T> {
	columns: ITableColumn<T>[];
	nameHeader: ReactNode;
	sort: ITableSort | null;
	onSortChange?: (sort: ITableSort) => void;
}

/** The details table: Name (with a small icon), then the caller's columns. */
function ListView<T extends IBrowserItem>({ items, ariaLabel, itemProps, columns, nameHeader, sort, onSortChange }: IListViewProps<T>): React.ReactElement {
	const nameColumn: ITableColumn<T> = { id: 'name', header: nameHeader, sortable: true, value: (item) => item.name };
	const allColumns = [nameColumn, ...columns];
	return (
		<table role="grid" aria-label={ariaLabel} aria-multiselectable="true" className="rr-table rr-table--dense rr-item-browser__table">
			<thead>
				<tr>
					{allColumns.map((column) => {
						let ariaSort: 'ascending' | 'descending' | 'none' | undefined;
						const isSortable = Boolean(column.sortable && onSortChange);
						if (isSortable) ariaSort = 'none';
						if (isSortable && sort?.columnId === column.id) ariaSort = sort.direction === 'asc' ? 'ascending' : 'descending';
						return (
							<th key={column.id} scope="col" aria-sort={ariaSort} style={{ textAlign: column.align ?? 'left', width: column.width }}>
								{isSortable && (
									<button
										type="button"
										className="rr-table__sort"
										data-sort={ariaSort}
										onClick={(event) => {
											event.stopPropagation();
											onSortChange?.(nextSort(sort, column.id));
										}}
									>
										{column.header}
										<span className="rr-table__sort-icon" aria-hidden="true" />
									</button>
								)}
								{!isSortable && column.header}
							</th>
						);
					})}
				</tr>
			</thead>
			<tbody>
				{items.map((item) => (
					<tr key={item.id} {...(itemProps(item, 'rr-item-browser__row') as React.HTMLAttributes<HTMLTableRowElement>)}>
						<td>
							<span className="rr-item-browser__row-name">
								<span className="rr-item-browser__row-icon" aria-hidden="true">
									{item.icon}
								</span>
								{item.name}
							</span>
						</td>
						{columns.map((column) => {
							let content: ReactNode = null;
							if (column.render) content = column.render(item);
							else if (column.value) content = String(column.value(item) ?? '');
							return (
								<td key={column.id} className={column.mono ? 'rr-text-mono' : undefined} style={{ textAlign: column.align ?? 'left' }}>
									{content}
								</td>
							);
						})}
					</tr>
				))}
			</tbody>
		</table>
	);
}

// =============================================================================
// HELPERS
// =============================================================================

interface ISection<T> {
	label: string;
	items: T[];
}

/** Groups items by their section, keeping the order sections first appear in. */
function groupBySection<T extends IBrowserItem>(items: readonly T[]): ISection<T>[] {
	const sections: ISection<T>[] = [];
	for (const item of items) {
		const label = item.section ?? '';
		let section = sections.find((candidate) => candidate.label === label);
		if (!section) {
			section = { label, items: [] };
			sections.push(section);
		}
		section.items.push(item);
	}
	return sections;
}

/** Tiles per row in the first grid section (1 in the list), for Up and Down. */
function columnCount(root: HTMLElement | null, view: ItemBrowserView): number {
	if (view === 'list' || !root) return 1;
	const grid = root.querySelector<HTMLElement>('.rr-item-browser__grid');
	if (!grid) return 1;
	const template = getComputedStyle(grid).gridTemplateColumns;
	const count = template.split(' ').filter((part) => part.trim() !== '').length;
	return Math.max(1, count);
}

/** The ids of the items whose elements a screen rectangle touches. */
function idsInRect(root: HTMLElement | null, rect: IBrowserRect): string[] {
	if (!root) return [];
	const ids: string[] = [];
	for (const element of root.querySelectorAll<HTMLElement>('[data-item-id]')) {
		const bounds = element.getBoundingClientRect();
		const itemRect = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
		if (rectsIntersect(rect, itemRect)) ids.push(element.dataset.itemId ?? '');
	}
	return ids;
}

/** Drags a small "3 items" label instead of one item's picture when several move. */
function setCountDragImage(event: React.DragEvent, count: number): void {
	const label = document.createElement('div');
	label.className = 'rr-item-browser__drag-count';
	label.textContent = `${count} items`;
	document.body.appendChild(label);
	event.dataTransfer.setDragImage(label, 12, 12);
	window.setTimeout(() => label.remove(), 0);
}

/** Escapes an id for an attribute selector. */
function cssEscape(value: string): string {
	if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
	return value.replace(/["\\]/g, '\\$&');
}
