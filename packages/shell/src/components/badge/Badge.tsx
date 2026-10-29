// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Badge — a count or dot pinned to the corner of an icon, avatar or tab:
 * unread messages, failed runs, pending invites. Counts above `max` show as
 * "99+". A zero count hides the badge unless `showZero` is set.
 *
 * The badge is visual; the meaning goes to screen readers through `label`
 * (e.g. "unread messages"), read after the count: "3 unread messages".
 * For a standalone status pill use StatusBadge instead.
 *
 * Built on `.rr-badge-host` and `.rr-count` from components.css.
 */

import React, { ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Badge tone: accent (the theme's button color) or error. */
export type BadgeTone = 'accent' | 'error';

/** Props for the {@link Badge} component. */
export interface IBadgeProps {
	/** The element the badge is pinned to. */
	children: ReactNode;
	/** The number to show. Ignored when `dot` is set. */
	count?: number;
	/** Largest number shown before "max+". Defaults to 99. */
	max?: number;
	/** Show a plain dot instead of a number. */
	dot?: boolean;
	/** Keep the badge visible at zero. */
	showZero?: boolean;
	/** Color. Defaults to `'accent'`. */
	tone?: BadgeTone;
	/** What the count means, for screen readers, e.g. `'unread messages'`. */
	label?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The text a count badge shows.
 *
 * @param count - The count.
 * @param max - The cap.
 * @returns e.g. `'7'` or `'99+'`.
 */
export function formatBadgeCount(count: number, max: number): string {
	if (count > max) return `${max}+`;
	return String(count);
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a child with a corner badge.
 *
 * @param props - {@link IBadgeProps}.
 * @returns The child wrapped with its badge.
 */
export function Badge({ children, count = 0, max = 99, dot = false, showZero = false, tone = 'accent', label }: IBadgeProps): React.ReactElement {
	const isVisible = dot || count > 0 || showZero;

	let badgeClassName = 'rr-count rr-badge-host__badge';
	if (dot) badgeClassName += ' rr-badge-host__badge--dot';
	if (tone === 'error') badgeClassName += ' rr-count--error';

	let spoken = '';
	if (dot && label) spoken = label;
	if (!dot && label) spoken = `${count} ${label}`;

	let shown = formatBadgeCount(count, max);
	if (dot) shown = '';

	return (
		<span className="rr-badge-host">
			{children}
			{isVisible && (
				<span className={badgeClassName} aria-hidden="true">
					{shown}
				</span>
			)}
			{isVisible && spoken && <span className="rr-sr-only">{spoken}</span>}
		</span>
	);
}
