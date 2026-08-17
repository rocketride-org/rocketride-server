// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Banner — the platform's stock view-level callout strip.
 *
 * Three semantic variants (info / warning / error). The border and text take the
 * full semantic token; the background is a 6% tint of the same token via
 * `color-mix`, so the strip reads clearly in both light and dark themes. Use a
 * Banner for view-level messages; use a StatusBadge for per-row / per-item state.
 */

import React, { CSSProperties, ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Semantic variant of a {@link Banner}. */
export type BannerVariant = 'info' | 'warning' | 'error';

/** Props for the {@link Banner} component. */
export interface IBannerProps {
	/** Semantic variant. */
	variant: BannerVariant;
	/** Message content. */
	children: ReactNode;
}

// =============================================================================
// VARIANT TOKENS
// =============================================================================

/** Semantic token per variant, used for border, text, and (tinted) background. */
const VARIANT_TOKENS: Record<BannerVariant, string> = {
	info: 'var(--rr-color-info)',
	warning: 'var(--rr-color-warning)',
	error: 'var(--rr-color-error)',
};

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	banner: {
		borderRadius: 8,
		padding: '12px 16px',
		fontSize: 13.5,
		borderWidth: 1,
		borderStyle: 'solid',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a semantic callout strip.
 *
 * @param props - {@link IBannerProps}.
 * @returns The banner element.
 */
export function Banner({ variant, children }: IBannerProps): React.ReactElement {
	// Resolve the semantic token, then tint the background from it.
	const token = VARIANT_TOKENS[variant];
	return (
		<div
			// Live region so dynamically-mounted banners (e.g. an in-thread chat
			// error) are announced by screen readers; errors interrupt, the rest
			// wait for an idle moment.
			role={variant === 'error' ? 'alert' : 'status'}
			aria-live={variant === 'error' ? 'assertive' : 'polite'}
			style={{
				...styles.banner,
				borderColor: token,
				color: token,
				background: `color-mix(in srgb, ${token} 6%, transparent)`,
			}}
		>
			{children}
		</div>
	);
}
