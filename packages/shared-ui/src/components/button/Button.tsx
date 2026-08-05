// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Button — the platform's stock action button.
 *
 * Four variants (primary / secondary / ghost / danger) and two optional compact
 * sizes: `small` (26px — card/grid header chrome) and `mini` (16px — canvas-node
 * chrome, where a 26px button overflows the node card). Every colour is drawn
 * from a `--rr-*` token so the button tracks
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
	/** Render the micro (16px tall) size — canvas-node chrome. Wins over `small`. */
	mini?: boolean;
	/** Disable the button — dimmed and non-interactive. */
	disabled?: boolean;
	/** Click handler. */
	onClick?: () => void;
	/** Button label / content. */
	children: ReactNode;
	/** Native tooltip text. */
	title?: string;
	/**
	 * ARIA pressed state for toggle/segmented usage (ToggleGroup) — rendered
	 * as `aria-pressed`; visual selection is conveyed by the variant.
	 */
	pressed?: boolean;
	/**
	 * ARIA expanded state for dropdown-trigger usage — rendered as
	 * `aria-expanded` so assistive tech knows the popup's open state.
	 */
	ariaExpanded?: boolean;
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

	// Compact size modifier (11px — the card-header / grid-header scale,
	// user spec 2026-07-16).
	small: {
		height: 26,
		padding: '0 11px',
		fontSize: 11,
		borderRadius: 6,
	} as CSSProperties,

	// Micro size modifier — the canvas-node scale (the former PipelineActions
	// micro-button tier, promoted to a stock size so nodes never need bespoke
	// button styles).
	mini: {
		height: 16,
		padding: '0 6px',
		fontSize: 9,
		fontWeight: 500,
		lineHeight: 1,
		gap: 4,
		borderRadius: 3,
	} as CSSProperties,

	// Ghost + small combination: quiet utility buttons (grid/card header
	// chrome like Export... and Clear) read at regular weight, not CTA
	// weight (user spec 2026-07-16).
	ghostSmall: {
		fontWeight: 400,
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
export function Button({ variant = 'primary', small, mini, disabled, onClick, children, title, pressed, ariaExpanded }: IButtonProps): React.ReactElement {
	// Compose base + variant colour + optional size (mini wins over small) +
	// the quiet ghost-small weight + optional disabled modifier.
	const style: CSSProperties = {
		...styles.base,
		...VARIANT_STYLES[variant],
		...(small ? styles.small : null),
		...(small && variant === 'ghost' ? styles.ghostSmall : null),
		...(mini ? styles.mini : null),
		...(disabled ? styles.disabled : null),
	};

	return (
		<button type="button" style={style} onClick={onClick} disabled={disabled} title={title} aria-pressed={pressed} aria-expanded={ariaExpanded}>
			{children}
		</button>
	);
}
