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
// VECTOR-UI - FOLDER RAIL (the Documents tab's folders: a WAI-ARIA tree)
// =============================================================================
//
// The folders of the documents the console has loaded (vector/tree.ts), with
// how many loaded documents each holds. Choosing a folder narrows the list
// beside it to that folder's documents, subfolders included: a view of what
// is loaded, so the store is not asked again, the folder's siblings stay in
// the rail, and the connection's scope (search, map and Ask) does not change.
// "All documents" shows every loaded document again; a document opens its
// drawer; Trash shows the Trash tab.
//
// One item is in the tab order at a time (roving tabindex); the keys are the
// APG tree's (vector/tree.ts treeKey, typeAhead), handled on the tree's own
// element. The items are windowed like the grid's rows, and the focused item
// is always rendered, so scrolling never takes the focus away.
// =============================================================================

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { IDocumentItem } from '../contract/types';
import { ACCENT_TOKEN, selectedRowBackground } from '../vector/colors';
import { gridWindow, nextFocusAfterRemoval, scrollToShow } from '../vector/grid';
import { formatCount } from '../vector/stats';
import { TREE_ALL, collapsedAll, treeItems, treeKey, typeAhead, viewItemId } from '../vector/tree';
import type { FolderView, IFolderTree, TreeItem } from '../vector/tree';
import { ChevronIcon } from '../icons';
import { FOCUS_RING, styles as appStyles } from '../styles';

/** An item's height (px). */
const ITEM_HEIGHT = 26;

/** Items rendered above and below the view. */
const OVERSCAN = 10;

/** How long typed letters add up for type-ahead (ms). */
const TYPE_AHEAD_MS = 600;

/** Layout effects in a browser; plain effects where nothing is laid out (a static render runs neither). */
const useLayoutish = typeof document === 'undefined' ? useEffect : useLayoutEffect;

const styles = {
	rail: { display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, height: '100%' } as CSSProperties,
	toolbar: { display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderBottom: '1px solid var(--rr-border)', flexWrap: 'wrap' } as CSSProperties,
	tool: { ...appStyles.small, padding: '2px 8px', border: '1px solid var(--rr-border-input)', borderRadius: 4, background: 'none', color: 'inherit', cursor: 'pointer' } as CSSProperties,
	counts: { ...appStyles.small, padding: '4px 10px' } as CSSProperties,
	tree: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', position: 'relative', outline: 'none' } as CSSProperties,
	item: (opts: { top: number; level: number; selected: boolean; focused: boolean; hovered: boolean }): CSSProperties => ({
		position: 'absolute',
		top: opts.top,
		left: 0,
		right: 0,
		height: ITEM_HEIGHT,
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		boxSizing: 'border-box',
		padding: `0 8px 0 ${4 + (opts.level - 1) * 14}px`,
		fontSize: 12.5,
		cursor: 'pointer',
		background: opts.selected ? selectedRowBackground() : opts.hovered ? 'var(--rr-bg-list-hover)' : 'transparent',
		boxShadow: opts.selected ? `inset 3px 0 0 var(${ACCENT_TOKEN})` : undefined,
		outline: opts.focused ? FOCUS_RING : 'none',
		outlineOffset: -2,
		whiteSpace: 'nowrap',
	}),
	chevron: (expanded: boolean): CSSProperties => ({ width: 12, height: 12, flex: 'none', transform: expanded ? 'rotate(90deg)' : 'none' }),
	spacer: { width: 12, flex: 'none' } as CSSProperties,
	label: (strong: boolean): CSSProperties => ({ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: strong ? 600 : 400 }),
	count: { ...appStyles.small, flex: 'none', marginLeft: 6 } as CSSProperties,
};

/** Props for the {@link FolderRail} component. */
export interface IFolderRailProps {
	/** The folders of the loaded documents (vector/tree.ts buildTree over the listing's rows). */
	tree: IFolderTree;
	/** What the counts are over, e.g. "Counts over 1,200 loaded documents". */
	countsLine: string;
	/** The folder the list is narrowed to, or null for every document. */
	view: FolderView | null;
	onView(view: FolderView | null): void;
	/** A document's item: open its drawer. */
	onOpenDocument(item: IDocumentItem): void;
	/** Documents in the trash as the store counts them, or null where it cannot count. */
	trashCount: number | null;
	/** The Trash item: show the Trash tab. */
	onTrash(): void;
	onRefresh(): void;
	/** Refresh is unavailable (the console has not opened). */
	refreshDisabled?: boolean;
}

/** Whether an item opens and closes. */
function opens(item: TreeItem): boolean {
	return item.kind === 'all' || item.kind === 'folder' || item.kind === 'uploaded';
}

/** An item's count, as the rail shows it. */
function countOf(item: TreeItem): string | null {
	if (item.kind === 'file') return item.item.chunks === null ? null : `${formatCount(item.item.chunks)} ch`;
	if (item.kind === 'trash') return item.count === null ? null : formatCount(item.count);
	return formatCount(item.count);
}

/** An item's accessible description (what its count is). */
function countWords(item: TreeItem): string | undefined {
	if (item.kind === 'file') return item.item.chunks === null ? 'chunk count not reported' : `${formatCount(item.item.chunks)} ${item.item.chunks === 1 ? 'chunk' : 'chunks'}`;
	if (item.kind === 'trash') return item.count === null ? undefined : `${formatCount(item.count)} in the trash`;
	return `${formatCount(item.count)} loaded ${item.count === 1 ? 'document' : 'documents'}`;
}

/**
 * The folder rail.
 *
 * @param props - {@link IFolderRailProps}.
 * @returns The rail element.
 */
export function FolderRail({ tree: built, countsLine, view, onView, onOpenDocument, trashCount, onTrash, onRefresh, refreshDisabled = false }: IFolderRailProps): React.ReactElement {
	const [flat, setFlat] = useState(false);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(collapsedAll);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [height, setHeight] = useState(300);
	const tree = useRef<HTMLDivElement>(null);
	const itemEls = useRef(new Map<string, HTMLElement>());
	const pending = useRef<string | null>(null);
	const focusInside = useRef(false);
	const typed = useRef({ text: '', timer: null as ReturnType<typeof setTimeout> | null });
	const [, setTick] = useState(0);

	const items = useMemo(() => treeItems(built, expanded, { flat, trash: trashCount }), [built, expanded, flat, trashCount]);
	const ids = useMemo(() => items.map((i) => i.id), [items]);
	const indexOf = useMemo(() => new Map(ids.map((id, i) => [id, i])), [ids]);
	const selectedId = viewItemId(view);
	const activeIndex = activeId === null ? -1 : (indexOf.get(activeId) ?? -1);
	const stop = activeIndex >= 0 ? activeIndex : (indexOf.get(selectedId) ?? 0);
	const rendered = gridWindow({ scrollTop, height, rowHeight: ITEM_HEIGHT, count: items.length, overscan: OVERSCAN, focused: stop });

	useEffect(() => {
		const el = tree.current;
		if (!el || typeof ResizeObserver === 'undefined') return undefined;
		const observer = new ResizeObserver(() => {
			if (el.clientHeight > 0) setHeight(el.clientHeight);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	useEffect(
		() => () => {
			if (typed.current.timer !== null) clearTimeout(typed.current.timer);
		},
		[]
	);

	// The focused item left (its folder closed, its document left the list): the focus goes to the next item, else the one before.
	const before = useRef<readonly string[]>(ids);
	useLayoutish(() => {
		const previous = before.current;
		before.current = ids;
		if (activeId === null || indexOf.has(activeId)) return;
		const next = nextFocusAfterRemoval(previous, new Set(ids), activeId) ?? TREE_ALL;
		setActiveId(next);
		const fell = typeof document !== 'undefined' && (document.activeElement === null || document.activeElement === document.body);
		if (focusInside.current && fell) pending.current = next;
	}, [ids, indexOf, activeId]);
	useLayoutish(() => {
		const id = pending.current;
		if (id === null) return;
		const el = itemEls.current.get(id);
		if (!el) return;
		pending.current = null;
		el.focus({ preventScroll: true });
	});

	/** Move the focus to an item, scrolling it into view. */
	const moveTo = (index: number): void => {
		const id = ids[index];
		if (id === undefined) return;
		const el = tree.current;
		if (el) {
			const to = scrollToShow(index, { scrollTop: el.scrollTop, height: el.clientHeight || height, rowHeight: ITEM_HEIGHT });
			if (to !== null) {
				el.scrollTop = to;
				setScrollTop(to);
			}
		}
		setActiveId(id);
		pending.current = id;
		setTick((n) => n + 1);
	};
	const toggle = (id: string, open: boolean): void => {
		const next = new Set(expanded);
		if (open) next.add(id);
		else next.delete(id);
		setExpanded(next);
	};
	const activate = (item: TreeItem): void => {
		if (item.kind === 'all') onView(null);
		else if (item.kind === 'folder') onView({ kind: 'folder', prefix: item.folder.prefix });
		else if (item.kind === 'uploaded') onView({ kind: 'uploaded' });
		else if (item.kind === 'file') onOpenDocument(item.item);
		else onTrash();
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
		if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
		const index = stop;
		const item = items[index];
		if (item === undefined) return;
		const action = treeKey(items, index, event.key);
		if (action !== null) {
			event.preventDefault();
			if (action.kind === 'move') moveTo(action.index);
			else if (action.kind === 'expand') toggle(action.id, true);
			else if (action.kind === 'collapse') toggle(action.id, false);
			else activate(item);
			return;
		}
		// Type-ahead: a printable letter moves to the next item that starts with what was typed.
		if (event.key.length === 1 && event.key !== ' ') {
			const buffer = typed.current;
			if (buffer.timer !== null) clearTimeout(buffer.timer);
			buffer.text += event.key;
			buffer.timer = setTimeout(() => {
				buffer.text = '';
				buffer.timer = null;
			}, TYPE_AHEAD_MS);
			const to = typeAhead(items, index, buffer.text);
			if (to >= 0) {
				event.preventDefault();
				moveTo(to);
			}
		}
	};

	const shown: number[] = [];
	for (let i = rendered.first; i < rendered.last; i++) shown.push(i);
	if (rendered.extra !== null) shown.push(rendered.extra);

	return (
		<nav aria-label="Folders" style={styles.rail} data-folder-rail="">
			<div style={styles.toolbar}>
				<button type="button" style={styles.tool} aria-pressed={flat} title={flat ? 'Switch to tree view' : 'Switch to flat view'} onClick={() => setFlat(!flat)} onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)} onBlur={(event) => (event.currentTarget.style.outline = 'none')}>
					Flat
				</button>
				<button type="button" style={styles.tool} onClick={() => setExpanded(collapsedAll())} onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)} onBlur={(event) => (event.currentTarget.style.outline = 'none')}>
					Collapse all
				</button>
				<button type="button" style={styles.tool} aria-disabled={refreshDisabled} onClick={() => !refreshDisabled && onRefresh()} onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)} onBlur={(event) => (event.currentTarget.style.outline = 'none')}>
					Refresh
				</button>
			</div>
			<div style={styles.counts}>{countsLine}</div>
			<div
				ref={tree}
				role="tree"
				aria-label="Folders of the loaded documents"
				style={styles.tree}
				onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
				onKeyDown={onKeyDown}
				onFocus={(event) => {
					focusInside.current = true;
					const id = (event.target as HTMLElement).dataset?.itemId ?? null;
					if (id !== null) {
						setActiveId(id);
						setFocusedId(id);
					}
				}}
				onBlur={(event) => {
					setFocusedId(null);
					const to = event.relatedTarget;
					if (to instanceof Node && tree.current?.contains(to)) return;
					const from = event.target;
					if (to !== null) focusInside.current = false;
					else
						setTimeout(() => {
							if (from.isConnected) focusInside.current = false;
						}, 0);
				}}
			>
				<div style={{ position: 'relative', height: items.length * ITEM_HEIGHT }}>
					{shown.map((index) => {
						const item = items[index] as TreeItem;
						const open = opens(item) && 'expanded' in item ? item.expanded : undefined;
						const selected = item.id === selectedId;
						const count = countOf(item);
						return (
							<div
								key={item.id}
								role="treeitem"
								data-item-id={item.id}
								aria-level={item.level}
								aria-setsize={item.setsize}
								aria-posinset={item.posinset}
								aria-expanded={open}
								aria-selected={item.kind === 'file' || item.kind === 'trash' ? undefined : selected}
								aria-label={countWords(item) ? `${item.label}, ${countWords(item)}` : item.label}
								tabIndex={index === stop ? 0 : -1}
								title={item.kind === 'file' ? item.item.path : item.kind === 'folder' ? item.folder.prefix : undefined}
								ref={(el) => {
									if (el) itemEls.current.set(item.id, el);
									else itemEls.current.delete(item.id);
								}}
								style={styles.item({ top: index * ITEM_HEIGHT, level: item.level, selected, focused: focusedId === item.id, hovered: hoveredId === item.id })}
								onMouseEnter={() => setHoveredId(item.id)}
								onMouseLeave={() => setHoveredId((h) => (h === item.id ? null : h))}
								onClick={(event) => {
									setActiveId(item.id);
									if (open !== undefined && (event.target as Element).closest('[data-chevron]')) toggle(item.id, !open);
									else activate(item);
								}}
							>
								{open !== undefined ? (
									<span data-chevron="" aria-hidden="true" style={styles.chevron(open)}>
										<ChevronIcon />
									</span>
								) : (
									<span aria-hidden="true" style={styles.spacer} />
								)}
								<span style={styles.label(item.kind === 'all' || item.kind === 'trash')}>{item.label}</span>
								{count !== null && (
									<span aria-hidden="true" style={styles.count}>
										{count}
									</span>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</nav>
	);
}

export default FolderRail;
