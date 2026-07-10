// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Chip + ChipAdd — the platform's stock tag pills.
 *
 * `Chip` is a removable tag: an info-tinted pill with an optional remove glyph.
 * `ChipAdd` is the paired "add" affordance: a neutral outlined pill prefixed with
 * a plus. Used for permissions, labels, and similar small tag collections.
 */

import React, { CSSProperties } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link Chip} component. */
export interface IChipProps {
	/** Tag label. */
	label: string;
	/** When provided, renders a remove glyph that calls this on activation. */
	onRemove?: () => void;
}

/** Props for the {@link ChipAdd} component. */
export interface IChipAddProps {
	/** Add-affordance label (rendered after the plus glyph). */
	label: string;
	/** Fired when the add affordance is activated. */
	onClick: () => void;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Base pill shared by Chip and ChipAdd.
	chip: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 7,
		padding: '5px 11px',
		borderRadius: 14,
		fontSize: 12,
		fontWeight: 600,
		background: 'color-mix(in srgb, var(--rr-color-info) 8%, transparent)',
		color: 'var(--rr-color-info)',
	} as CSSProperties,

	// Removable-tag glyph.
	remove: {
		opacity: 0.65,
		cursor: 'pointer',
	} as CSSProperties,

	// Neutral outlined treatment for the add affordance.
	add: {
		background: 'transparent',
		border: '1px solid var(--rr-border)',
		color: 'var(--rr-text-primary)',
		cursor: 'pointer',
	} as CSSProperties,
};

// =============================================================================
// COMPONENTS
// =============================================================================

/**
 * Renders a removable tag pill.
 *
 * @param props - {@link IChipProps}.
 * @returns The chip element.
 */
export function Chip({ label, onRemove }: IChipProps): React.ReactElement {
	return (
		<span style={styles.chip}>
			{label}
			{/* Optional remove glyph (multiplication sign). */}
			{onRemove && (
				<span
					role="button"
					aria-label="Remove"
					tabIndex={0}
					style={styles.remove}
					onClick={onRemove}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							onRemove();
						}
					}}
				>
					{'×'}
				</span>
			)}
		</span>
	);
}

/**
 * Renders the "add" tag affordance.
 *
 * @param props - {@link IChipAddProps}.
 * @returns The add-chip element.
 */
export function ChipAdd({ label, onClick }: IChipAddProps): React.ReactElement {
	return (
		<span
			role="button"
			tabIndex={0}
			style={{ ...styles.chip, ...styles.add }}
			onClick={onClick}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onClick();
				}
			}}
		>
			{'+ '}
			{label}
		</span>
	);
}
