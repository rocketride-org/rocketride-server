// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * EmptyState — the platform's stock "nothing here yet" placeholder.
 *
 * A centred column with an optional icon, a title, an optional one-line
 * description, and at most one action (typically a single primary Button). Used
 * for empty lists, no-document landings, zero-result searches, and first-paint
 * loading messages.
 */

import React, { CSSProperties, ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link EmptyState} component. */
export interface IEmptyStateProps {
	/** Optional icon rendered above the title (inherits the disabled text colour). */
	icon?: ReactNode;
	/** Heading line. */
	title: string;
	/** Optional supporting line beneath the title. */
	description?: string;
	/** Optional single action (at most one Button). */
	action?: ReactNode;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		textAlign: 'center',
		padding: '48px 24px',
		border: '1px dashed var(--rr-border-hover)',
		borderRadius: 10,
		background: 'var(--rr-bg-surface-alt)',
	} as CSSProperties,

	icon: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 40,
		height: 40,
		color: 'var(--rr-text-disabled)',
		marginBottom: 14,
	} as CSSProperties,

	title: {
		fontSize: 15,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	description: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		margin: '6px 0 16px',
		maxWidth: 380,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a centred empty-state placeholder.
 *
 * @param props - {@link IEmptyStateProps}.
 * @returns The empty-state element.
 */
export function EmptyState({ icon, title, description, action }: IEmptyStateProps): React.ReactElement {
	return (
		<div style={styles.container}>
			{/* Optional icon slot. */}
			{icon && <div style={styles.icon}>{icon}</div>}
			{/* Title. */}
			<div style={styles.title}>{title}</div>
			{/* Optional description (carries the 16px gap to the action below it). */}
			{description && <div style={styles.description}>{description}</div>}
			{/* Optional action — when there is no description, restore the 16px gap. */}
			{action && <div style={{ marginTop: description ? 0 : 16 }}>{action}</div>}
		</div>
	);
}
