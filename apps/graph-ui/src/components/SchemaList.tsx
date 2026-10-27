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
// GRAPH-UI - SCHEMA LIST (the sidebar's labels and relationship types)
// =============================================================================
//
// A hand-built list in place of the shell's Explorer tree, whose entries have no
// colour or icon hook: every label row carries its colour dot (the same colour
// the canvas, legend and Overview draw it in, from the connection's style), and
// a relationship type its own when one was chosen. Each row has its count and a
// disclosure for what the schema holds about it.
//
//   Click or Enter      the 25-row preview (the existing request)
//   Right-click, the …  a menu: Preview 25 in a new tab, New query with this
//   button, Shift+F10   label (or type), Copy name, Copy as pattern
//   or the Menu key
//   Arrows              the WAI-ARIA tree pattern (graph/schemaTree.ts)
//
// Each section is one tree with one tab stop (roving tabindex). The menu is the
// shell's AnchoredPopup (it closes on an outside press and Escape) holding a
// WAI-ARIA menu: focus moves to its first item, and back to the row when it
// closes. It lives in the sidebar, never in a document. A line under the header
// (a status region) says what was copied, or shows the text to copy by hand
// where the window does not allow the clipboard.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import { AnchoredPopup, BxChevronDown, BxChevronRight, BxCollapseAll, BxDotsHorizontal, BxRefresh, commonStyles } from 'shell';
import type { GraphDialect } from '../cypher/quote';
import type { ILabelColor } from '../graph/colors';
import { listKeyAction, menuItemsFor, menuKeyAction, patternText } from '../graph/schemaTree';
import type { ISchemaList, ISchemaListItem, ISchemaMenuItem, ISchemaRow } from '../graph/schemaTree';

const styles = {
	section: { padding: '2px 6px' } as CSSProperties,
	header: { display: 'flex', alignItems: 'center' } as CSSProperties,
	headerLabel: { flex: 1, padding: '6px 8px 4px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--rr-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
	headerActions: commonStyles.paneHeaderActions,
	headerAction: commonStyles.paneHeaderButton,
	headerActionBlocked: { ...commonStyles.paneHeaderButton, opacity: 0.4, cursor: 'default' } as CSSProperties,
	group: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px 2px', fontSize: 12, fontWeight: 600, color: 'var(--rr-text-secondary)' } as CSSProperties,
	groupCount: { fontWeight: 400 } as CSSProperties,
	line: (active: boolean, hovered: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '1px 4px 1px 4px',
		borderRadius: 5,
		fontSize: 13,
		lineHeight: '22px',
		cursor: 'pointer',
		...(active ? { background: 'var(--rr-bg-list-active)', color: 'var(--rr-fg-list-active)' } : hovered ? { background: 'var(--rr-bg-list-hover)' } : null),
	}),
	treeitem: { outlineOffset: -1 } as CSSProperties,
	chevron: { display: 'inline-flex', width: 16, justifyContent: 'center', flexShrink: 0, color: 'var(--rr-text-secondary)' } as CSSProperties,
	dot: (fill: string): CSSProperties => ({ width: 10, height: 10, borderRadius: '50%', background: fill, border: '1px solid var(--rr-text-primary)', flexShrink: 0 }),
	typeMark: (stroke: string): CSSProperties => ({ width: 12, height: 0, borderTop: `2px solid ${stroke}`, flexShrink: 0 }),
	name: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
	count: { flexShrink: 0, fontSize: 12, color: 'var(--rr-text-secondary)' } as CSSProperties,
	kebab: (shown: boolean): CSSProperties => ({ ...commonStyles.paneHeaderButton, opacity: shown ? 1 : 0, flexShrink: 0 }),
	detail: (active: boolean): CSSProperties => ({ display: 'flex', gap: 8, padding: '0 8px 0 42px', fontSize: 12, lineHeight: '20px', color: 'var(--rr-text-secondary)', borderRadius: 5, ...(active ? { background: 'var(--rr-bg-list-hover)' } : null) }),
	detailName: { color: 'var(--rr-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
	menu: { minWidth: 210, padding: 4, background: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border)', borderRadius: 6, boxShadow: '0 4px 14px rgba(0, 0, 0, 0.25)' } as CSSProperties,
	menuItem: (disabled: boolean): CSSProperties => ({ padding: '4px 10px', fontSize: 13, borderRadius: 4, cursor: disabled ? 'default' : 'pointer', color: disabled ? 'var(--rr-text-disabled)' : 'var(--rr-text-primary)', outlineOffset: -1 }),
	empty: { padding: '2px 8px 4px 18px', fontSize: 12, color: 'var(--rr-text-secondary)' } as CSSProperties,
	copied: { padding: '0 8px', fontSize: 12, color: 'var(--rr-text-secondary)', wordBreak: 'break-word' } as CSSProperties,
	copyText: { userSelect: 'all', fontFamily: 'var(--rr-font-mono, monospace)' } as CSSProperties,
};

/** Props. */
export interface ISchemaListProps {
	/** The section's title (the connection's name). */
	title: string;
	list: ISchemaList;
	/** Each label's colour (graph/colors.ts labelColors over the connection's style). */
	colors: ReadonlyMap<string, ILabelColor>;
	/** A colour per relationship type a person chose one for. */
	typeColors: ReadonlyMap<string, string>;
	/** The connection's engine (patterns are quoted its way), or null. */
	dialect: GraphDialect | null;
	/** What the list says while it has no rows. */
	emptyText: string;
	/** Whether Refresh schema cannot run now (it says so with aria-disabled). */
	refreshBlocked: boolean;
	onRefresh(): void;
	/** The 25-row preview (run). */
	onPreview(kind: 'label' | 'type', name: string): void;
	/** A new query with the label or type (not run). */
	onNewQuery(kind: 'label' | 'type', name: string): void;
}

/** How long the line saying what was copied stays. */
const COPIED_NOTE_MS = 6_000;

/**
 * Copy text.
 *
 * @param text - What to copy.
 * @returns Whether the clipboard took it.
 */
async function copy(text: string): Promise<boolean> {
	try {
		if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return false;
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

/** One row's menu: a WAI-ARIA menu in the shell's anchored popup. */
const RowMenu: React.FC<{ row: ISchemaRow; items: ISchemaMenuItem[]; anchor: React.RefObject<HTMLElement | null>; onChoose(item: ISchemaMenuItem): void; onClose(returnFocus: boolean): void }> = ({ row, items, anchor, onChoose, onClose }) => {
	const first = items.findIndex((item) => !item.disabled);
	const [at, setAt] = useState(first);
	const refs = useRef<Array<HTMLDivElement | null>>([]);
	useEffect(() => {
		refs.current[at]?.focus();
	}, [at]);
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		const action = menuKeyAction(event.key, at, items);
		if (!action) return;
		event.preventDefault();
		if ('focus' in action) setAt(action.focus);
		else if ('choose' in action) onChoose(items[action.choose]);
		else onClose(action.close === 'escape');
	};
	return (
		<AnchoredPopup anchorRef={anchor} open onClose={() => onClose(true)} align="start" style={styles.menu}>
			<div role="menu" aria-label={`Actions for ${row.text}`} onKeyDown={onKeyDown}>
				{items.map((item, index) => (
					<div
						key={item.id}
						ref={(el) => {
							refs.current[index] = el;
						}}
						role="menuitem"
						tabIndex={-1}
						aria-disabled={item.disabled || undefined}
						style={styles.menuItem(item.disabled)}
						onMouseEnter={() => {
							if (!item.disabled) setAt(index);
						}}
						onClick={() => {
							if (!item.disabled) onChoose(item);
						}}
					>
						{item.label}
					</div>
				))}
			</div>
		</AnchoredPopup>
	);
};

/** One section (labels, or relationship types): a tree with one tab stop. */
const Section: React.FC<{
	heading: string;
	rows: ISchemaRow[];
	expanded: ReadonlySet<string>;
	onToggle(id: string): void;
	colors: ReadonlyMap<string, ILabelColor>;
	typeColors: ReadonlyMap<string, string>;
	dialect: GraphDialect | null;
	onPreview(kind: 'label' | 'type', name: string): void;
	onNewQuery(kind: 'label' | 'type', name: string): void;
	onCopied(text: string, ok: boolean, what: string): void;
}> = ({ heading, rows, expanded, onToggle, colors, typeColors, dialect, onPreview, onNewQuery, onCopied }) => {
	const [focus, setFocus] = useState<ISchemaListItem>({ row: 0, detail: null });
	const [hovered, setHovered] = useState<string | null>(null);
	const [menu, setMenu] = useState<number | null>(null);
	const lines = useRef(new Map<string, HTMLElement>());
	const anchor = useRef<HTMLElement | null>(null);
	const moved = useRef(false);
	const headingId = useMemo(() => `graph-schema-${heading.replace(/\W+/g, '-').toLowerCase()}`, [heading]);
	const itemKey = (item: ISchemaListItem): string => `${item.row}:${item.detail ?? 'row'}`;

	// A focus kept on a row that is gone (a new schema) falls back to the first row.
	const current: ISchemaListItem = rows[focus.row] && (focus.detail === null || (expanded.has(rows[focus.row].id) && focus.detail < rows[focus.row].details.length)) ? focus : { row: Math.min(focus.row, Math.max(0, rows.length - 1)), detail: null };
	useEffect(() => {
		if (!moved.current) return;
		moved.current = false;
		lines.current.get(itemKey(current))?.focus();
	});

	const move = (item: ISchemaListItem): void => {
		moved.current = true;
		setFocus(item);
	};
	const openMenu = (index: number): void => {
		anchor.current = lines.current.get(`${index}:row`) ?? null;
		setFocus({ row: index, detail: null });
		setMenu(index);
	};
	const closeMenu = (returnFocus: boolean): void => {
		const index = menu;
		setMenu(null);
		if (returnFocus && index !== null) move({ row: index, detail: null });
	};
	const choose = (row: ISchemaRow, item: ISchemaMenuItem): void => {
		closeMenu(true);
		switch (item.id) {
			case 'preview':
				onPreview(row.kind, row.name);
				return;
			case 'query':
				onNewQuery(row.kind, row.name);
				return;
			case 'copy-name':
				void copy(row.name).then((ok) => onCopied(row.name, ok, 'name'));
				return;
			case 'copy-pattern': {
				const pattern = patternText(row.kind, row.name, dialect);
				if (pattern !== null) void copy(pattern).then((ok) => onCopied(pattern, ok, 'pattern'));
				return;
			}
		}
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (menu !== null) return;
		const action = listKeyAction({ key: event.key, shiftKey: event.shiftKey }, current, rows, expanded);
		if (!action) return;
		event.preventDefault();
		if ('focus' in action) move(action.focus);
		else if ('toggle' in action) onToggle(action.toggle);
		else if ('activate' in action) onPreview(rows[action.activate].kind, rows[action.activate].name);
		else openMenu(action.menu);
	};
	const onRowClick = (event: MouseEvent<HTMLElement>, index: number): void => {
		const target = event.target as HTMLElement;
		const row = rows[index];
		if (target.closest('[data-disclosure]')) onToggle(row.id);
		else if (target.closest('[data-menu]')) openMenu(index);
		else if (!target.closest('[data-detail]')) onPreview(row.kind, row.name);
		setFocus({ row: index, detail: null });
	};

	return (
		<>
			<div id={headingId} style={styles.group}>
				{heading} <span style={styles.groupCount}>{rows.length.toLocaleString('en-US')}</span>
			</div>
			{rows.length > 0 && (
				<div role="tree" aria-labelledby={headingId} onKeyDown={onKeyDown}>
					{rows.map((row, index) => {
						const open = expanded.has(row.id);
						const active = menu === index;
						const isFocus = current.row === index && current.detail === null;
						const label = colors.get(row.name);
						const typeColor = typeColors.get(row.name);
						return (
							<div
								key={row.id}
								role="treeitem"
								aria-level={1}
								aria-expanded={row.details.length > 0 ? open : undefined}
								aria-label={row.count ? `${row.text}, ${row.count}` : row.text}
								style={styles.treeitem}
								ref={(el) => {
									if (el) lines.current.set(`${index}:row`, el);
									else lines.current.delete(`${index}:row`);
								}}
								tabIndex={isFocus ? 0 : -1}
								title={`${row.kind === 'label' ? 'Label' : 'Relationship type'} ${row.text}. Click to preview 25; right-click or Shift+F10 for more.`}
								onClick={(event) => onRowClick(event, index)}
								onContextMenu={(event) => {
									event.preventDefault();
									openMenu(index);
								}}
								onFocus={(event) => {
									if (event.target === event.currentTarget) setFocus({ row: index, detail: null });
								}}
							>
								<div style={styles.line(active, hovered === row.id)} onMouseEnter={() => setHovered(row.id)} onMouseLeave={() => setHovered((h) => (h === row.id ? null : h))}>
									<span data-disclosure="" style={styles.chevron} aria-hidden="true">
										{row.details.length > 0 ? open ? <BxChevronDown size={14} /> : <BxChevronRight size={14} /> : null}
									</span>
									{row.kind === 'label' ? <span style={styles.dot(label?.fill ?? 'var(--rr-grey-400)')} aria-hidden="true" /> : <span style={styles.typeMark(typeColor ?? 'var(--rr-text-secondary)')} aria-hidden="true" />}
									<span style={styles.name}>{row.text}</span>
									{row.count && <span style={styles.count}>{row.count}</span>}
									<span data-menu="" style={styles.kebab(hovered === row.id || isFocus || active)} aria-hidden="true">
										<BxDotsHorizontal size={16} />
									</span>
								</div>
								{open && (
									<div role="group">
										{row.details.map((detail, d) => (
											<div
												key={d}
												data-detail=""
												role="treeitem"
												aria-level={2}
												aria-label={`${detail.name}: ${detail.detail}`}
												tabIndex={current.row === index && current.detail === d ? 0 : -1}
												style={styles.detail(current.row === index && current.detail === d)}
												ref={(el) => {
													if (el) lines.current.set(`${index}:${d}`, el);
													else lines.current.delete(`${index}:${d}`);
												}}
												onFocus={(event) => {
													if (event.target === event.currentTarget) setFocus({ row: index, detail: d });
												}}
											>
												<span style={styles.detailName}>{detail.name}</span>
												<span>{detail.detail}</span>
											</div>
										))}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
			{/* Outside the tree (a tree holds tree items only); the popup is portalled, but its events still bubble here. */}
			{menu !== null && rows[menu] && <RowMenu row={rows[menu]} items={menuItemsFor(rows[menu].kind, rows[menu].name, dialect)} anchor={anchor} onChoose={(item) => choose(rows[menu], item)} onClose={closeMenu} />}
		</>
	);
};

/**
 * The schema list.
 *
 * @param props - See {@link ISchemaListProps}.
 * @returns The list.
 */
export const SchemaList: React.FC<ISchemaListProps> = ({ title, list, colors, typeColors, dialect, emptyText, refreshBlocked, onRefresh, onPreview, onNewQuery }) => {
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	// What was copied (or the text to copy by hand), on a line that says it and leaves by itself.
	const [copied, setCopied] = useState<{ text: string; ok: boolean; what: string } | null>(null);
	useEffect(() => {
		if (!copied?.ok) return undefined;
		const timer = window.setTimeout(() => setCopied(null), COPIED_NOTE_MS);
		return () => window.clearTimeout(timer);
	}, [copied]);
	const [paneHovered, setPaneHovered] = useState(false);
	const [paneFocused, setPaneFocused] = useState(false);
	const toggle = (id: string): void =>
		setExpanded((previous) => {
			const next = new Set(previous);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const shared = { expanded, onToggle: toggle, colors, typeColors, dialect, onPreview, onNewQuery, onCopied: (text: string, ok: boolean, what: string) => setCopied({ text, ok, what }) };
	const empty = list.labels.length + list.types.length === 0;
	return (
		<div style={styles.section} onMouseEnter={() => setPaneHovered(true)} onMouseLeave={() => setPaneHovered(false)} onFocus={() => setPaneFocused(true)} onBlur={() => setPaneFocused(false)}>
			<div style={styles.header}>
				<span style={styles.headerLabel} title={title}>{title}</span>
				<div style={styles.headerActions(paneHovered || paneFocused)}>
					<button type="button" style={expanded.size === 0 ? styles.headerActionBlocked : styles.headerAction} title="Collapse all" aria-label="Collapse all" aria-disabled={expanded.size === 0} onClick={() => setExpanded(new Set())}>
						<BxCollapseAll size={18} />
					</button>
					<button type="button" style={refreshBlocked ? styles.headerActionBlocked : styles.headerAction} title="Refresh schema" aria-label="Refresh schema" aria-disabled={refreshBlocked} onClick={() => { if (!refreshBlocked) onRefresh(); }}>
						<BxRefresh size={18} />
					</button>
				</div>
			</div>
			<div role="status" style={styles.copied}>
				{copied && (copied.ok ? `Copied the ${copied.what}.` : <>This window does not allow the clipboard. Select the {copied.what} and copy it: <code style={styles.copyText}>{copied.text}</code></>)}
			</div>
			{empty ? (
				<div style={styles.empty}>{emptyText}</div>
			) : (
				<>
					<Section heading="Node labels" rows={list.labels} {...shared} />
					<Section heading="Relationship types" rows={list.types} {...shared} />
				</>
			)}
		</div>
	);
};

export default SchemaList;
