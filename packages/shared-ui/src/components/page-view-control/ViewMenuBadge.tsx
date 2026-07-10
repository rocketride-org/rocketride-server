// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ViewMenuBadge — the internal count badge shared by both ViewMenu components.
 *
 * A small rounded pill showing a numeric count. Both the {@link PageViewControl}
 * and the {@link SidebarMenu} render the exact same badge, so it lives here
 * once and is imported by each component. Not part of the shared-ui public
 * surface — it is an internal building block of the two menu components.
 *
 * Two treatments, keyed by the entry's optional `severity`:
 * - neutral (default): `--rr-bg-widget-header` fill, `--rr-text-secondary` text.
 * - `'error'`: `--rr-color-error` fill, `--rr-fg-button` text (e.g. Errors 2).
 */

import React, { CSSProperties } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link ViewMenuBadge} component. */
export interface IViewMenuBadgeProps {
	/** The numeric count to display. */
	count: number;
	/** 'error' renders the pill in the error colour instead of the neutral fill. */
	severity?: 'error';
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Base pill — sizing and typography shared by both treatments.
	badge: {
		minWidth: 20,
		textAlign: 'center',
		padding: '2px 6px',
		borderRadius: 10,
		fontSize: 10.5,
		fontWeight: 700,
	} as CSSProperties,

	// Neutral treatment — a quiet count chip. The 1px --rr-border outline keeps
	// the pill visible in themes whose --rr-bg-widget-header resolves to (near-)
	// transparent — e.g. the vscode webviews map it to
	// --vscode-sideBarSectionHeader-background, which is invisible on the strip
	// in the VS Code light theme.
	neutral: {
		background: 'var(--rr-bg-widget-header)',
		color: 'var(--rr-text-secondary)',
		border: '1px solid var(--rr-border)',
	} as CSSProperties,

	// Error treatment — a filled state chip. Border matches the fill so both
	// treatments box out to the same size.
	error: {
		background: 'var(--rr-color-error)',
		color: 'var(--rr-fg-button)',
		border: '1px solid var(--rr-color-error)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the shared count badge for a ViewMenu entry.
 *
 * @param props - {@link IViewMenuBadgeProps}.
 * @returns The badge element.
 */
export function ViewMenuBadge({ count, severity }: IViewMenuBadgeProps): React.ReactElement {
	// Pick the treatment: error entries get the filled error chip, all others neutral.
	const treatment = severity === 'error' ? styles.error : styles.neutral;
	return <span style={{ ...styles.badge, ...treatment }}>{count}</span>;
}
