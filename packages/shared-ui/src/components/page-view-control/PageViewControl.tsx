// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PageViewControl — the tabs-across-the-top strip showing a view's pages.
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
 */

import React, { CSSProperties, KeyboardEvent, ReactNode, useRef } from 'react';
import { cardHeaderChrome } from '../card/Card';
import { ViewMenu } from '../../types/viewMenu';
import { ViewMenuBadge } from './ViewMenuBadge';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link PageViewControl} component. */
export interface IPageViewControlProps {
	/** The declared menu whose entries render as the strip tabs. */
	menu: ViewMenu;
	/** Id of the currently active entry (drawn with the brand underline). */
	activeId: string;
	/** Fired with an entry id when the user selects it. */
	onSelect: (id: string) => void;
	/** Right-aligned slot (e.g. expand icon). Optional. */
	trailing?: ReactNode;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// The strip — the row of tabs at the very top of the view's content column,
	// filled with the CARD-HEADER background sourced from Card's exported
	// chrome (single source, never re-declared) so it reads as header chrome.
	// NO margins: the fill runs flush to the host's edge, and the vertical
	// padding provides the breathing room INSIDE the band.
	strip: {
		flex: 'none',
		display: 'flex',
		alignItems: 'stretch',
		gap: 2,
		padding: '15px 10px',
		borderBottom: '1px solid var(--rr-border)',
		background: cardHeaderChrome.header.background,
	} as CSSProperties,

	// A single strip tab; the active treatment is layered on top. The active
	// underline indicator sits on the entry's bottom edge (the strip's bottom).
	tab: (active: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 7,
		padding: '0 13px',
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
 * @param props - {@link IPageViewControlProps}.
 * @returns The strip element.
 */
export function PageViewControl({ menu, activeId, onSelect, trailing }: IPageViewControlProps): React.ReactElement {
	// Refs to the rendered tab elements, for roving-focus keyboard navigation.
	const tabRefs = useRef<(HTMLDivElement | null)[]>([]);
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
		<div style={styles.strip} role="tablist">
			{menu.entries.map((entry, index) => {
				// The active tab carries the brand underline + primary text colour.
				const isActive = entry.id === activeId;
				return (
					<div
						key={entry.id}
						ref={(el) => {
							tabRefs.current[index] = el;
						}}
						role="tab"
						aria-selected={isActive}
						// Roving tabIndex: only the active tab sits in the page tab
						// order; Arrow / Home / End move within the strip.
						tabIndex={isActive || (activeIndex === -1 && index === 0) ? 0 : -1}
						style={styles.tab(isActive)}
						onClick={() => onSelect(entry.id)}
						onKeyDown={(e) => handleKeyDown(e, index, entry.id)}
					>
						{entry.label}
						{/* Count badge when the entry declares a count. */}
						{entry.count != null && <ViewMenuBadge count={entry.count} severity={entry.severity} />}
					</div>
				);
			})}
			{/* Optional right-aligned slot, e.g. an expand icon. */}
			{trailing != null && <div style={styles.trailing}>{trailing}</div>}
		</div>
	);
}
