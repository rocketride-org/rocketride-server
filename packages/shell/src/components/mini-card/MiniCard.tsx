// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * MiniCard + MiniContainer — the compact metric tiles and their grid.
 *
 * `MiniCard` is a small bordered tile with a big value over an uppercase caption
 * label (the "1,284 / DOCUMENTS" tiles). Long string values automatically drop
 * to a smaller size so they don't overflow the tile. `MiniContainer` lays a row
 * of MiniCards out in an equal-width grid.
 */

import React, { CSSProperties, ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link MiniCard} component. */
export interface IMiniCardProps {
	/**
	 * Optional heading rendered ABOVE the value, to be used under very
	 * specific circumstances only — `label` is the preferred mode. When
	 * `title` is specified it renders uppercase, and `label` may then be
	 * mixed case.
	 */
	title?: string;
	/** The metric value (number, formatted string, or a custom node). */
	value: ReactNode;
	/**
	 * Caption beneath the value. Uppercase by default; when a `title` heading
	 * is present the uppercase treatment moves to the title and the label
	 * renders as authored (mixed case allowed).
	 */
	label: string;
	/**
	 * Optional CSS color for the value text (e.g. 'var(--rr-color-success)').
	 * Defaults to the primary text color.
	 */
	color?: string;
}

/** Props for the {@link MiniContainer} component. */
export interface IMiniContainerProps {
	/** Explicit column count; defaults to one column per child. */
	columns?: number;
	/** The MiniCards to lay out. */
	children: ReactNode;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** String values longer than this render at the compact value size. */
const COMPACT_VALUE_LENGTH = 12;

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	card: {
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		padding: 16,
		background: 'var(--rr-bg-paper)',
	} as CSSProperties,

	// Standard large value.
	value: {
		fontSize: 22,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	// Compact value modifier for long strings.
	valueCompact: {
		fontSize: 15,
	} as CSSProperties,

	label: {
		marginTop: 6,
		fontSize: 10.5,
		fontWeight: 700,
		textTransform: 'uppercase',
		letterSpacing: '0.12em',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	// Above-value heading (`title` prop): the label caption spec, placed above
	// the value (margin flipped below instead of above). Always uppercase.
	title: {
		marginBottom: 6,
		fontSize: 10.5,
		fontWeight: 700,
		textTransform: 'uppercase',
		letterSpacing: '0.12em',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	// Mixed-case modifier for `label` when a `title` heading is present: the
	// uppercase treatment AND the bold weight belong to the title, so the
	// label renders as authored at normal weight.
	labelMixed: {
		textTransform: 'none',
		fontWeight: 400,
	} as CSSProperties,

	// Equal-width grid; column count supplied by the caller or child count.
	container: (columns: number): CSSProperties => ({
		display: 'grid',
		gridTemplateColumns: `repeat(${columns}, 1fr)`,
		gap: 16,
	}),
};

// =============================================================================
// COMPONENTS
// =============================================================================

/**
 * Renders a single compact metric tile: optional uppercase `title` heading
 * above the value (very specific circumstances only — `label` is the
 * preferred mode), the value in an optional `color`, and the `label` caption
 * beneath (uppercase by default; mixed case allowed when `title` is present).
 *
 * @param props - {@link IMiniCardProps}.
 * @returns The tile element.
 */
export function MiniCard({ title, value, label, color }: IMiniCardProps): React.ReactElement {
	// Long string values drop to the compact size so they fit the tile.
	const compact = typeof value === 'string' && value.length > COMPACT_VALUE_LENGTH;
	// Compose the value style: base, compact-size modifier, then the color override.
	const valueStyle: CSSProperties = {
		...styles.value,
		...(compact ? styles.valueCompact : undefined),
		...(color ? { color } : undefined),
	};
	// With a title heading the uppercase treatment belongs to the title, so the
	// label renders as authored (mixed case allowed).
	const labelStyle: CSSProperties = title ? { ...styles.label, ...styles.labelMixed } : styles.label;
	return (
		<div style={styles.card}>
			{title && <div style={styles.title}>{title}</div>}
			<div style={valueStyle}>{value}</div>
			<div style={labelStyle}>{label}</div>
		</div>
	);
}

/**
 * Renders a grid row of {@link MiniCard}s.
 *
 * @param props - {@link IMiniContainerProps}.
 * @returns The grid element.
 */
export function MiniContainer({ columns, children }: IMiniContainerProps): React.ReactElement {
	// Default to one equal column per child (min 1 to keep the grid valid).
	const cols = columns ?? Math.max(React.Children.count(children), 1);
	return <div style={styles.container(cols)}>{children}</div>;
}
