// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * StatusBadge + StatusDot — the platform's stock state indicators.
 *
 * Five semantic variants (success / info / warning / error / muted), each keyed
 * to a state token. `StatusDot` is the bare 7px coloured dot; `StatusBadge` is a
 * pill combining the dot with a text label. Both are colour-only state signals —
 * never use them for ad-hoc, non-state colouring.
 *
 * Tinted borders and backgrounds are derived from the semantic tokens with
 * `color-mix`, so they stay legible in both light and dark themes.
 */

import React, { CSSProperties, ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Semantic state variant shared by {@link StatusBadge} and {@link StatusDot}. */
export type StatusVariant = 'success' | 'info' | 'warning' | 'error' | 'muted';

/** Props for the {@link StatusBadge} component. */
export interface IStatusBadgeProps {
	/** Semantic state variant. */
	variant: StatusVariant;
	/** Label content. */
	children: ReactNode;
}

/** Props for the {@link StatusDot} component. */
export interface IStatusDotProps {
	/** Semantic state variant. */
	variant: StatusVariant;
}

// =============================================================================
// VARIANT PALETTES
// =============================================================================

/** Dot fill colour per variant (also used for the dot inside a badge). */
const DOT_COLORS: Record<StatusVariant, string> = {
	success: 'var(--rr-color-success)',
	info: 'var(--rr-color-info)',
	warning: 'var(--rr-color-warning)',
	error: 'var(--rr-color-error)',
	muted: 'var(--rr-text-disabled)',
};

/** Text / border / background treatment for the badge pill, per variant. */
interface IBadgePalette {
	/** Label text colour. */
	text: string;
	/** Pill border colour. */
	border: string;
	/** Pill background fill. */
	background: string;
}

const BADGE_PALETTES: Record<StatusVariant, IBadgePalette> = {
	success: {
		text: 'var(--rr-color-success)',
		border: 'color-mix(in srgb, var(--rr-color-success) 40%, transparent)',
		background: 'color-mix(in srgb, var(--rr-color-success) 7%, transparent)',
	},
	info: {
		text: 'var(--rr-color-info)',
		border: 'color-mix(in srgb, var(--rr-color-info) 40%, transparent)',
		background: 'color-mix(in srgb, var(--rr-color-info) 6%, transparent)',
	},
	warning: {
		text: 'var(--rr-color-warning)',
		border: 'color-mix(in srgb, var(--rr-color-warning) 55%, transparent)',
		background: 'color-mix(in srgb, var(--rr-color-warning) 10%, transparent)',
	},
	error: {
		text: 'var(--rr-color-error)',
		border: 'color-mix(in srgb, var(--rr-color-error) 40%, transparent)',
		background: 'color-mix(in srgb, var(--rr-color-error) 6%, transparent)',
	},
	muted: {
		text: 'var(--rr-text-secondary)',
		border: 'var(--rr-border)',
		background: 'var(--rr-bg-surface-alt)',
	},
};

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	dot: {
		width: 7,
		height: 7,
		borderRadius: '50%',
		flexShrink: 0,
	} as CSSProperties,

	badge: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 7,
		height: 22,
		padding: '0 10px',
		borderRadius: 20,
		fontSize: 11.5,
		fontWeight: 600,
		borderWidth: 1,
		borderStyle: 'solid',
	} as CSSProperties,
};

// =============================================================================
// COMPONENTS
// =============================================================================

/**
 * Renders the bare 7px status dot.
 *
 * @param props - {@link IStatusDotProps}.
 * @returns The dot element.
 */
export function StatusDot({ variant }: IStatusDotProps): React.ReactElement {
	return <span style={{ ...styles.dot, background: DOT_COLORS[variant] }} />;
}

/**
 * Renders a dot + label status pill.
 *
 * @param props - {@link IStatusBadgeProps}.
 * @returns The badge element.
 */
export function StatusBadge({ variant, children }: IStatusBadgeProps): React.ReactElement {
	// Resolve the pill treatment for the requested variant.
	const palette = BADGE_PALETTES[variant];
	return (
		<span style={{ ...styles.badge, color: palette.text, borderColor: palette.border, background: palette.background }}>
			<StatusDot variant={variant} />
			{children}
		</span>
	);
}
