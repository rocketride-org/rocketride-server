// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Card — the platform's stock bordered content group.
 *
 * A paper surface with a 1px border and rounded corners, an optional header row
 * (title + right-aligned actions) on a quiet `--rr-bg-surface-alt` fill
 * separated from the body by a divider, an optional `toolbar` row beneath the
 * header (e.g. a filter/search strip), and a padded body. Set `noBodyPadding`
 * for content that fills the card edge-to-edge (e.g. a DataTable).
 *
 * Pass `onClick` to make the whole card interactive: it then shows a pointer
 * cursor, a subtle hover treatment (border-color shifts to `--rr-border-hover`),
 * and button semantics (role="button", Enter / Space keyboard activation).
 * Without `onClick` the card renders as a plain static surface, unchanged.
 *
 * Built on `commonStyles.card` / `cardBody`; the header treatment is composed on
 * top of `commonStyles.cardHeader` and overridden to the approved spec (filled
 * `--rr-bg-surface-alt` bar — design-owner decision 2026-07-08 — bottom divider,
 * 13.5/700 title) — see the note in the styles block.
 */

import React, { CSSProperties, KeyboardEvent, ReactNode, useState } from 'react';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link Card} component. */
export interface ICardProps {
	/** Header content — a plain string title or a custom node. */
	header?: ReactNode;
	/** Right side of the header row (actions / controls). */
	headerActions?: ReactNode;
	/** Card body content. */
	children: ReactNode;
	/** Drop the body padding (for tables and media that fill the card). */
	noBodyPadding?: boolean;
	/**
	 * Optional row rendered directly beneath the header row (and above the body):
	 * filter/search strips, ToggleGroups, or any custom controls — e.g. hosting a
	 * DataTable's filter box at the card level. Renders with its own divider.
	 */
	toolbar?: ReactNode;
	/**
	 * Makes the whole card clickable. When set, the card gains a pointer cursor,
	 * a hover border-color shift, and button semantics (role="button", keyboard
	 * Enter / Space activation). When omitted the card is a static surface.
	 */
	onClick?: () => void;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Header — composes commonStyles.cardHeader, keeping its themed
	// --rr-bg-titleBar-inactive fill (the header color develop shipped, which
	// resolves to a real per-theme tint everywhere — the vscode theme maps it to
	// --vscode-titleBar-inactiveBackground, NOT editor-background, so it stays
	// visible). Only the divergent properties are overridden to the approved
	// spec: left-aligned title, a bottom divider, and a 13.5px/700 title
	// (commonStyles ships 13/600).
	header: {
		...commonStyles.cardHeader,
		justifyContent: 'flex-start',
		borderBottom: '1px solid var(--rr-border)',
		fontSize: 13.5,
		fontWeight: 700,
	} as CSSProperties,

	// Push header actions to the right edge of the header row.
	headerActions: {
		marginLeft: 'auto',
	} as CSSProperties,

	// Toolbar row under the header: a horizontal strip for filter/search
	// controls, divided from the body like the header is.
	toolbar: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		padding: '10px 16px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	// Body with padding removed (fills the card).
	bodyNoPad: {
		padding: 0,
	} as CSSProperties,

	// Interactive surface layered onto commonStyles.card when the card is
	// clickable: a pointer cursor plus a hover-driven border-color shift. The
	// hover is mouse-state driven because inline styles cannot express :hover.
	// All three border longhands are emitted in BOTH hover states so the style
	// object's property set never changes across renders — conditionally adding
	// a borderColor longhand over commonStyles.card's border shorthand made
	// React's style diffing leave the hover color behind on mouse-out (the
	// stuck-outline bug, fixed in SidebarMenu the same way).
	interactive: (hovered: boolean): CSSProperties => ({
		cursor: 'pointer',
		borderWidth: 1,
		borderStyle: 'solid',
		borderColor: hovered ? 'var(--rr-border-hover)' : 'var(--rr-border)',
	}),
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a bordered card with an optional header and a padded body.
 *
 * @param props - {@link ICardProps}.
 * @returns The card element.
 */
export function Card({ header, headerActions, children, noBodyPadding, toolbar, onClick }: ICardProps): React.ReactElement {
	// Track hover so a clickable card can raise its border; stays false (and
	// unused) for a static card, which attaches no mouse handlers.
	const [hovered, setHovered] = useState(false);

	// Only render the header row when there is a title or actions to show.
	const showHeader = header != null || headerActions != null;
	// A card is interactive only when the caller supplies an onClick handler.
	const interactive = onClick != null;

	/**
	 * Activates the card from the keyboard when it is interactive: Enter or Space
	 * fire the click handler, matching native button keys (Space's default page
	 * scroll is suppressed).
	 *
	 * @param e - The keyboard event raised on the card element.
	 */
	const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
		if (!onClick) return;
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onClick();
		}
	};

	return (
		<div
			// Interactive cards layer the pointer/hover treatment; static cards keep
			// exactly commonStyles.card so their rendering is unchanged.
			style={interactive ? { ...commonStyles.card, ...styles.interactive(hovered) } : commonStyles.card}
			onClick={onClick}
			onKeyDown={interactive ? handleKeyDown : undefined}
			onMouseEnter={interactive ? () => setHovered(true) : undefined}
			onMouseLeave={interactive ? () => setHovered(false) : undefined}
			role={interactive ? 'button' : undefined}
			tabIndex={interactive ? 0 : undefined}
		>
			{showHeader && (
				<div style={styles.header}>
					{header}
					{headerActions && <div style={styles.headerActions}>{headerActions}</div>}
				</div>
			)}
			{/* Optional controls strip between the header and the body. */}
			{toolbar != null && <div style={styles.toolbar}>{toolbar}</div>}
			<div style={noBodyPadding ? styles.bodyNoPad : commonStyles.cardBody}>{children}</div>
		</div>
	);
}
