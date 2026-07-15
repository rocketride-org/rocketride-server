// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Button — the platform's stock action button.
 *
 * Four variants (primary / secondary / ghost / danger) and an optional compact
 * `small` size. Every colour is drawn from a `--rr-*` token so the button tracks
 * light and dark themes automatically. The disabled state composes
 * `commonStyles.buttonDisabled` (dimmed + non-interactive).
 *
 * At most one `primary` Button should appear per view (it is the page's single
 * call to action); `danger` is reserved for destructive actions.
 */

import React, { CSSProperties, ReactNode } from 'react';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// TYPES
// =============================================================================

/** Visual variant of a {@link Button}. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** Props for the {@link Button} component. */
export interface IButtonProps {
	/** Visual variant. Defaults to `'primary'`. */
	variant?: ButtonVariant;
	/** Render the compact (26px tall) size. */
	small?: boolean;
	/** Disable the button — dimmed and non-interactive. */
	disabled?: boolean;
	/** Click handler. */
	onClick?: () => void;
	/** Button label / content. */
	children: ReactNode;
	/** Native tooltip text. */
	title?: string;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Shared base — sizing, radius, and typography common to every variant.
	base: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 7,
		height: 34,
		padding: '0 16px',
		fontFamily: 'inherit',
		fontSize: 13,
		fontWeight: 600,
		borderRadius: 7,
		cursor: 'pointer',
		border: '1px solid transparent',
		whiteSpace: 'nowrap',
	} as CSSProperties,

	// Compact size modifier.
	small: {
		height: 26,
		padding: '0 11px',
		fontSize: 12,
		borderRadius: 6,
	} as CSSProperties,

	// Variant colour treatments.
	primary: {
		background: 'var(--rr-bg-button)',
		borderColor: 'var(--rr-bg-button)',
		color: 'var(--rr-fg-button)',
	} as CSSProperties,
	secondary: {
		background: 'transparent',
		borderColor: 'var(--rr-brand)',
		color: 'var(--rr-brand)',
	} as CSSProperties,
	ghost: {
		background: 'transparent',
		borderColor: 'var(--rr-border)',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	danger: {
		background: 'var(--rr-color-error)',
		borderColor: 'var(--rr-color-error)',
		color: 'var(--rr-fg-button)',
	} as CSSProperties,

	// Disabled modifier — half opacity, no pointer interaction.
	disabled: {
		...commonStyles.buttonDisabled,
		pointerEvents: 'none',
	} as CSSProperties,
};

/** Lookup of the per-variant colour treatment. */
const VARIANT_STYLES: Record<ButtonVariant, CSSProperties> = {
	primary: styles.primary,
	secondary: styles.secondary,
	ghost: styles.ghost,
	danger: styles.danger,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a themed action button.
 *
 * @param props - {@link IButtonProps}.
 * @returns The button element.
 */
export function Button({ variant = 'primary', small, disabled, onClick, children, title }: IButtonProps): React.ReactElement {
	// Compose base + variant colour + optional size + optional disabled modifier.
	const style: CSSProperties = {
		...styles.base,
		...VARIANT_STYLES[variant],
		...(small ? styles.small : null),
		...(disabled ? styles.disabled : null),
	};

	return (
		<button type="button" style={style} onClick={onClick} disabled={disabled} title={title}>
			{children}
		</button>
	);
}
