// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ContentHeader — the standard page header for every shell-ui view/document.
 *
 * Opens a view with a large title, an optional one-line subtitle describing the
 * view, and optional right-aligned actions (at most one primary Button per view).
 * This is the shell-ui page grammar header; the VS Code host does not use it (the
 * editor tab + breadcrumb already name the document).
 */

import React, { CSSProperties, ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link ContentHeader} component. */
export interface IContentHeaderProps {
	/** Page / document title. */
	title: string;
	/** Optional one-line description of the view. */
	subtitle?: string;
	/** Optional right-aligned actions (primary Button at most once per view). */
	actions?: ReactNode;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Header gutter — 24px sides + top, no bottom (content owns the 20px gap below).
	container: {
		padding: '24px 24px 0',
	} as CSSProperties,

	// Title + actions on one baseline-centred row.
	titleRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 16,
	} as CSSProperties,

	// Rendered as an h1 for assistive-tech navigation; margin reset because
	// the styles here fully own the type scale.
	title: {
		margin: 0,
		fontSize: 24,
		fontWeight: 700,
		letterSpacing: '-0.01em',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	// Right-aligned action cluster.
	actions: {
		marginLeft: 'auto',
		display: 'flex',
		gap: 10,
	} as CSSProperties,

	subtitle: {
		marginTop: 4,
		fontSize: 14,
		fontWeight: 400,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the standard page header.
 *
 * @param props - {@link IContentHeaderProps}.
 * @returns The header element.
 */
export function ContentHeader({ title, subtitle, actions }: IContentHeaderProps): React.ReactElement {
	return (
		<div style={styles.container}>
			{/* Title row: title on the left, actions pushed to the right. */}
			<div style={styles.titleRow}>
				<h1 style={styles.title}>{title}</h1>
				{actions && <div style={styles.actions}>{actions}</div>}
			</div>
			{/* Optional subtitle beneath the title. */}
			{subtitle && <div style={styles.subtitle}>{subtitle}</div>}
		</div>
	);
}
