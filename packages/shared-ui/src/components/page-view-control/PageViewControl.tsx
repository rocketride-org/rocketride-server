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
 * Card/DataTable — views with sub-views must use this stock component and
 * never hand-roll their own tab bars.
 */

import React, { CSSProperties, ReactNode } from 'react';
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
	// The strip — snug row of tabs at the very top of the view's content column.
	// The 5px top margin breathes it off whatever sits above (DocTabs, dialog
	// edge, breadcrumb) — design-owner decision 2026-07-08.
	strip: {
		flex: 'none',
		display: 'flex',
		alignItems: 'stretch',
		gap: 2,
		height: 38,
		marginTop: 5,
		padding: '0 10px',
		borderBottom: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-default)',
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
	return (
		<div style={styles.strip} role="tablist">
			{menu.entries.map((entry) => {
				// The active tab carries the brand underline + primary text colour.
				const isActive = entry.id === activeId;
				return (
					<div
						key={entry.id}
						role="tab"
						aria-selected={isActive}
						tabIndex={0}
						style={styles.tab(isActive)}
						onClick={() => onSelect(entry.id)}
						onKeyDown={(e) => {
							// Enter / Space activate the tab, matching native button semantics.
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								onSelect(entry.id);
							}
						}}
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
