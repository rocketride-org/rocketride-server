// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Section + LabelValue — the DetailPanel body vocabulary.
 *
 * `Section` is an uppercase label with an underline divider that introduces a
 * block of detail rows. `LabelValue` is a single label/value row with a fixed
 * label column; set `mono` to render the value in a monospace face (IDs, hashes,
 * endpoints). Usable in any settings-like view, not just the DetailPanel.
 */

import React, { CSSProperties, ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link Section} component. */
export interface ISectionProps {
	/** Uppercase section label. */
	label: string;
	/** Section body (typically {@link LabelValue} rows). */
	children: ReactNode;
}

/** Props for the {@link LabelValue} component. */
export interface ILabelValueProps {
	/** Row label (fixed-width left column). */
	label: string;
	/** Row value. */
	children: ReactNode;
	/** Render the value in a monospace face. */
	mono?: boolean;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Uppercase section label with an underline divider.
	sectionLabel: {
		fontSize: 11,
		fontWeight: 700,
		textTransform: 'uppercase',
		letterSpacing: '0.08em',
		color: 'var(--rr-text-secondary)',
		paddingBottom: 7,
		borderBottom: '1px solid var(--rr-border)',
		margin: '20px 0 8px',
	} as CSSProperties,

	// Single label/value row.
	row: {
		display: 'flex',
		alignItems: 'center',
		padding: '7px 0',
		fontSize: 13,
	} as CSSProperties,

	// Fixed-width label column.
	rowLabel: {
		width: 150,
		flexShrink: 0,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	value: {
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	// Monospace value modifier.
	valueMono: {
		fontFamily: "Consolas, 'Courier New', monospace",
		fontSize: 12,
	} as CSSProperties,
};

// =============================================================================
// COMPONENTS
// =============================================================================

/**
 * Renders an uppercase section label + divider above its children.
 *
 * @param props - {@link ISectionProps}.
 * @returns The section element.
 */
export function Section({ label, children }: ISectionProps): React.ReactElement {
	return (
		<div>
			<div style={styles.sectionLabel}>{label}</div>
			{children}
		</div>
	);
}

/**
 * Renders a single label/value row.
 *
 * @param props - {@link ILabelValueProps}.
 * @returns The row element.
 */
export function LabelValue({ label, children, mono }: ILabelValueProps): React.ReactElement {
	return (
		<div style={styles.row}>
			<div style={styles.rowLabel}>{label}</div>
			<div style={mono ? { ...styles.value, ...styles.valueMono } : styles.value}>{children}</div>
		</div>
	);
}
