// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * TabControl — the tabs-across-the-top strip showing a view's pages.
 *
 * Renders a view's declared {@link ViewMenu} as a compact 38px strip of
 * uppercase tabs, the active tab marked by a 2px brand underline on the
 * strip's bottom edge. The VIEW ITSELF renders it as the very first element
 * of its own content column — above any ContentHeader; the page title lives
 * inside each page, below the strip.
 *
 * There is no publish/host machinery: consistency is enforced the same way as
 * Card/DataGrid — views with sub-views must use this stock component and
 * never hand-roll their own tab bars.
 *
 * Entries may carry a one-sentence `description` of what the page is for.
 * TabControl does not render the description visibly; it is the tooltip of
 * the entry's tab, and of its row in the overflow menu.
 */

import React, { CSSProperties, KeyboardEvent, ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cardHeaderChrome } from '../card/Card';
import { BxChevronDown } from '../BoxIcon';
import { ViewMenu } from '../../types/viewMenu';
import { ViewMenuBadge } from './ViewMenuBadge';
import { entryDescription } from './entryDescription';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link TabControl} component. */
export interface ITabControlProps {
	/** The declared menu whose entries render as the strip tabs. */
	menu: ViewMenu;
	/** Id of the currently active entry (drawn with the brand underline). */
	activeId: string;
	/** Fired with an entry id when the user selects it. */
	onSelect: (id: string) => void;
	/** Right-aligned slot (e.g. expand icon). Optional. */
	trailing?: ReactNode;
	/**
	 * Render each entry's `icon` INSTEAD of its label (the label becomes the
	 * tab's tooltip and accessible name; an entry's `description` follows the
	 * label in the tooltip). Entries without an icon keep their text label,
	 * so a mixed menu stays legible. Optional; default false.
	 */
	iconsOnly?: boolean;
	/**
	 * Enables drag-reordering of the entries marked `draggable` on the menu.
	 * Fired on drop with the dragged entry, the entry it was dropped on, and
	 * which side of it the drop landed. Entries without `draggable` are
	 * neither drag sources nor drop targets. Optional.
	 */
	onReorder?: (dragId: string, targetId: string, position: 'before' | 'after') => void;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// The strip — the row of tabs at the very top of the view's content column,
	// filled with the CARD-HEADER background sourced from Card's exported
	// chrome (single source, never re-declared) so it reads as header chrome.
	// NO margins: the fill runs flush to the host's edge, and the vertical
	// padding provides the breathing room INSIDE the band. Most of the band's
	// vertical room lives on the tabs themselves (see `tab`), so the strip only
	// carries the residual gap above/below the tab row.
	strip: {
		flex: 'none',
		display: 'flex',
		alignItems: 'stretch',
		gap: 2,
		padding: '12px 10px',
		borderBottom: '1px solid var(--rr-border)',
		background: cardHeaderChrome.header.background,
		// Overflow handling is MEASURED (hidden tabs collapse behind the
		// chevron menu); anything that still spills during a measure pass
		// must not paint outside the band.
		position: 'relative' as const,
		overflow: 'hidden' as const,
		minWidth: 0,
	} as CSSProperties,

	// The right-edge overflow chevron — appears only when tabs are hidden.
	overflowBtn: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '2px 2px',
		marginLeft: 'auto',
		border: 'none',
		borderRadius: 4,
		background: 'transparent',
		color: 'var(--rr-text-secondary)',
		cursor: 'pointer',
		flexShrink: 0,
	} as CSSProperties,

	// The overflow menu: hidden tabs as icon + label rows. Rendered as a
	// SIBLING of the strip (the strip clips its own overflow).
	overflowMenu: {
		position: 'absolute' as const,
		top: '100%',
		right: 6,
		zIndex: 30,
		minWidth: 180,
		padding: '4px 0',
		borderRadius: 8,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-paper)',
		boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
	} as CSSProperties,

	overflowRow: (active: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		width: '100%',
		padding: '7px 14px',
		border: 'none',
		backgroundColor: 'transparent',
		color: active ? 'var(--rr-text-primary)' : 'var(--rr-text-secondary)',
		fontSize: 12.5,
		fontWeight: active ? 700 : 500,
		textAlign: 'left' as const,
		cursor: 'pointer',
		boxSizing: 'border-box' as const,
	}),

	// A single strip tab; the active treatment is layered on top. The active
	// underline indicator sits on the entry's bottom edge (the strip's bottom).
	// The tab carries its OWN vertical padding — the underline lives on this
	// element, so the inset keeps the centred content (label + count badge)
	// clear of it instead of resting flush against the 2px line.
	tab: (active: boolean, compact: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 7,
		// Icon-only tabs are COMPACT: a 16px glyph behind 13px side padding
		// reads as a gap-toothed strip; 7px keeps the row tight.
		padding: compact ? '5px 7px' : '5px 13px',
		fontSize: 11.5,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: '0.08em',
		color: active ? 'var(--rr-text-primary)' : 'var(--rr-text-secondary)',
		borderBottom: `2px solid ${active ? 'var(--rr-brand)' : 'transparent'}`,
		cursor: 'pointer',
	}),

	// Right-aligned trailing slot (e.g. expand icon).
	trailing: {
		marginLeft: 'auto',
		display: 'flex',
		alignItems: 'center',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a ViewMenu as the top page strip.
 *
 * @param props - {@link ITabControlProps}.
 * @returns The strip element.
 */
export function TabControl({ menu, activeId, onSelect, trailing, iconsOnly, onReorder }: ITabControlProps): React.ReactElement {
	// Refs to the rendered tab elements, for roving-focus keyboard navigation.
	const tabRefs = useRef<(HTMLDivElement | null)[]>([]);
	// Drag-reorder state: the entry being dragged, and the current drop
	// indicator (target entry + which side the insertion lands).
	const dragIdRef = useRef<string | null>(null);
	const [dropHint, setDropHint] = useState<{ id: string; side: 'before' | 'after' } | null>(null);

	// ── Measured overflow ────────────────────────────────────────────────────
	// When the strip is narrower than its tabs, the tail collapses behind a
	// chevron menu (icon + label per hidden tab). Widths are measured on a
	// render-all pass, then the fit is recomputed from the stored widths on
	// every container resize.
	const stripRef = useRef<HTMLDivElement | null>(null);
	const trailingRef = useRef<HTMLDivElement | null>(null);
	const tabWidthsRef = useRef<number[]>([]);
	const [visibleCount, setVisibleCount] = useState(menu.entries.length);
	const [overflowOpen, setOverflowOpen] = useState(false);
	const overflowMenuRef = useRef<HTMLDivElement | null>(null);
	const entriesKey = menu.entries.map((e) => e.id).join('\0');

	/** Fits as many tabs as the strip's width allows (chevron space reserved). */
	const recomputeFit = useCallback(() => {
		const strip = stripRef.current;
		const widths = tabWidthsRef.current;
		if (!strip || widths.length !== menu.entries.length) return;
		const GAP = 2;
		const PADDING = 20; // strip's own 10px left + right
		const CHEVRON = 24;
		const avail = strip.clientWidth - PADDING - (trailingRef.current?.offsetWidth ?? 0);
		let total = 0;
		let fitAll = 0;
		for (let i = 0; i < widths.length; i++) {
			total += widths[i] + (i > 0 ? GAP : 0);
			if (total <= avail) fitAll = i + 1; else break;
		}
		if (fitAll >= widths.length) {
			setVisibleCount(widths.length);
			return;
		}
		// Not everything fits — refit leaving room for the chevron, keeping
		// at least one tab visible.
		let total2 = 0;
		let fit = 0;
		for (let i = 0; i < widths.length; i++) {
			total2 += widths[i] + (i > 0 ? GAP : 0);
			if (total2 <= avail - CHEVRON) fit = i + 1; else break;
		}
		setVisibleCount(Math.max(fit, 1));
	}, [menu.entries.length]);

	// Entries changed: render everything once so widths can be measured.
	useLayoutEffect(() => {
		tabWidthsRef.current = [];
		setVisibleCount(menu.entries.length);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the entry SET
	}, [entriesKey]);

	// Measure on the render-all pass (before paint), then fit.
	useLayoutEffect(() => {
		if (visibleCount !== menu.entries.length || tabWidthsRef.current.length === menu.entries.length) return;
		tabWidthsRef.current = tabRefs.current.slice(0, menu.entries.length).map((el) => (el ? el.offsetWidth : 0));
		recomputeFit();
	});

	// Container resizes refit from the stored widths.
	useEffect(() => {
		const strip = stripRef.current;
		if (!strip || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => recomputeFit());
		ro.observe(strip);
		return () => ro.disconnect();
	}, [recomputeFit]);

	// Close the overflow menu on outside click (the chevron is part of the
	// widget — closing on ITS mousedown would fight the click toggle).
	const chevronRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		if (!overflowOpen) return;
		const handler = (e: MouseEvent) => {
			const target = e.target as Node;
			if (chevronRef.current?.contains(target)) return;
			if (overflowMenuRef.current && !overflowMenuRef.current.contains(target)) setOverflowOpen(false);
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [overflowOpen]);

	const hiddenEntries = menu.entries.slice(visibleCount);
	// Index of the active entry; -1 when activeId matches nothing (then the
	// first tab stays tabbable so the strip never falls out of the tab order).
	const activeIndex = menu.entries.findIndex((entry) => entry.id === activeId);

	/**
	 * Selects and focuses the entry at `index` (wrapping both ends) — the ARIA
	 * tabs roving-tabindex pattern, where selection follows focus.
	 *
	 * @param index - Target entry index; may be out of range (it wraps).
	 */
	const moveTo = (index: number): void => {
		const count = menu.entries.length;
		if (count === 0) return;
		const next = ((index % count) + count) % count;
		onSelect(menu.entries[next].id);
		tabRefs.current[next]?.focus();
	};

	/**
	 * Keyboard handling per the ARIA tabs pattern: Enter / Space activate,
	 * Arrow keys move to the neighbour, Home / End jump to the edges.
	 *
	 * @param e - The keydown event.
	 * @param index - Index of the tab that received the key.
	 * @param id - Id of that tab's entry.
	 */
	const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>, index: number, id: string): void => {
		switch (e.key) {
			case 'Enter':
			case ' ':
				e.preventDefault();
				onSelect(id);
				break;
			case 'ArrowRight':
				e.preventDefault();
				moveTo(index + 1);
				break;
			case 'ArrowLeft':
				e.preventDefault();
				moveTo(index - 1);
				break;
			case 'Home':
				e.preventDefault();
				moveTo(0);
				break;
			case 'End':
				e.preventDefault();
				moveTo(menu.entries.length - 1);
				break;
		}
	};

	return (
		<div style={{ position: 'relative' }}>
		<div style={styles.strip} role="tablist" ref={stripRef}>
			{menu.entries.map((entry, index) => {
				// The active tab carries the brand underline + primary text colour.
				const isActive = entry.id === activeId;
				// Icon-only mode swaps the text for the entry's icon; the label
				// survives as the tooltip + accessible name. No icon → label.
				const asIcon = Boolean(iconsOnly && entry.icon);
				// Drag-reorder wiring — only entries marked draggable, only
				// when the host passed onReorder.
				const reorderable = Boolean(onReorder && entry.draggable);
				const hint = dropHint?.id === entry.id ? dropHint.side : null;
				// What the page is for, when the entry says (trimmed; blank
				// counts as absent).
				const description = entryDescription(entry);
				return (
					<div
						key={entry.id}
						ref={(el) => {
							tabRefs.current[index] = el;
						}}
						role="tab"
						aria-selected={isActive}
						aria-label={asIcon ? entry.label : undefined}
						// The native tooltip. A text tab shows the entry's
						// description; an icon tab shows its label, then the
						// description after a colon. The label stays the
						// accessible name, so browsers expose the title as the
						// accessible description. In icon mode a screen reader
						// therefore hears the label twice (the name, then the
						// start of the description); that is accepted, because a
						// label-only tooltip would hide the description on
						// exactly the tabs that show no text. A text tab without
						// a description renders no attribute.
						title={asIcon ? (description ? `${entry.label}: ${description}` : entry.label) : description}
						// Roving tabIndex: only the active tab sits in the page tab
						// order; Arrow / Home / End move within the strip.
						tabIndex={isActive || (activeIndex === -1 && index === 0) ? 0 : -1}
						style={{
							...styles.tab(isActive, asIcon),
							// Measured overflow: tabs past the fit collapse into
							// the chevron menu.
							...(index >= visibleCount ? { display: 'none' } : {}),
							// Insertion indicator: a brand edge on the side the
							// drop would land.
							...(hint === 'before' ? { boxShadow: 'inset 2px 0 0 var(--rr-brand)' } : {}),
							...(hint === 'after' ? { boxShadow: 'inset -2px 0 0 var(--rr-brand)' } : {}),
						}}
						onClick={() => onSelect(entry.id)}
						onKeyDown={(e) => handleKeyDown(e, index, entry.id)}
						draggable={reorderable}
						onDragStart={reorderable ? (e) => {
							dragIdRef.current = entry.id;
							e.dataTransfer.effectAllowed = 'move';
							e.dataTransfer.setData('text/plain', entry.id);
						} : undefined}
						onDragOver={reorderable ? (e) => {
							if (!dragIdRef.current || dragIdRef.current === entry.id) return;
							e.preventDefault();
							e.dataTransfer.dropEffect = 'move';
							const rect = e.currentTarget.getBoundingClientRect();
							const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
							setDropHint((prev) => (prev?.id === entry.id && prev.side === side ? prev : { id: entry.id, side }));
						} : undefined}
						onDragLeave={reorderable ? () => {
							setDropHint((prev) => (prev?.id === entry.id ? null : prev));
						} : undefined}
						onDrop={reorderable ? (e) => {
							e.preventDefault();
							const dragId = dragIdRef.current;
							dragIdRef.current = null;
							setDropHint(null);
							if (dragId && dragId !== entry.id) {
								const side = e.clientX < e.currentTarget.getBoundingClientRect().left + e.currentTarget.getBoundingClientRect().width / 2 ? 'before' : 'after';
								onReorder!(dragId, entry.id, side);
							}
						} : undefined}
						onDragEnd={reorderable ? () => {
							dragIdRef.current = null;
							setDropHint(null);
						} : undefined}
					>
						{asIcon ? entry.icon : entry.label}
						{/* Count badge when the entry declares a count. */}
						{entry.count != null && <ViewMenuBadge count={entry.count} severity={entry.severity} />}
					</div>
				);
			})}
			{/* Overflow chevron — only when tabs are hidden. */}
			{hiddenEntries.length > 0 && (
				<button
					type="button"
					ref={chevronRef}
					title="More tabs"
					aria-label="More tabs"
					aria-haspopup="menu"
					aria-expanded={overflowOpen}
					style={styles.overflowBtn}
					onClick={() => setOverflowOpen((v) => !v)}
				>
					<BxChevronDown size={16} />
				</button>
			)}
			{/* Optional right-aligned slot, e.g. an expand icon. */}
			{trailing != null && <div style={styles.trailing} ref={trailingRef}>{trailing}</div>}
		</div>

		{/* The hidden tabs, as icon + label rows (sibling of the strip — the
		    strip clips its own overflow). */}
		{overflowOpen && hiddenEntries.length > 0 && (
			<div ref={overflowMenuRef} role="menu" style={styles.overflowMenu}>
				{hiddenEntries.map((entry) => (
					<button
						key={entry.id}
						type="button"
						role="menuitem"
						// The row shows the label, so it gets the same tooltip
						// as a text tab: the description, or no attribute.
						title={entryDescription(entry)}
						style={styles.overflowRow(entry.id === activeId)}
						onClick={() => {
							setOverflowOpen(false);
							onSelect(entry.id);
						}}
					>
						{entry.icon && <span style={{ display: 'flex', flexShrink: 0 }}>{entry.icon}</span>}
						<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.label}</span>
						{entry.count != null && <ViewMenuBadge count={entry.count} severity={entry.severity} />}
					</button>
				))}
			</div>
		)}
		</div>
	);
}
