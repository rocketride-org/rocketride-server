// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Skeleton — a shimmering placeholder in the shape of content that is still
 * loading, so the layout does not jump when it arrives. Use it for the first
 * load of cards, rows and text; use a Spinner for short in-place waits.
 *
 * Skeletons are hidden from screen readers. Mark the region that is loading
 * with `aria-busy="true"` so assistive tech knows to wait.
 *
 * Built on `.rr-skeleton` from components.css.
 */

import React, { CSSProperties } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link Skeleton} component. */
export interface ISkeletonProps {
	/** Width (CSS length or px). Defaults to `'100%'`. */
	width?: number | string;
	/** Height (CSS length or px). Defaults to 12. */
	height?: number | string;
	/** A circle (avatars, icons); `width` sets the diameter. */
	circle?: boolean;
	/** Render a paragraph of this many lines; the last is shorter. */
	lines?: number;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Widths for a skeleton paragraph: full lines, then a shorter last line.
 *
 * @param lines - Number of lines.
 * @returns One CSS width per line.
 */
export function paragraphWidths(lines: number): string[] {
	const widths: string[] = [];
	for (let index = 0; index < lines; index++) {
		if (index === lines - 1 && lines > 1) {
			widths.push('60%');
		} else {
			widths.push('100%');
		}
	}
	return widths;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a loading placeholder.
 *
 * @param props - {@link ISkeletonProps}.
 * @returns The placeholder, or a stack of lines.
 */
export function Skeleton({ width = '100%', height = 12, circle = false, lines }: ISkeletonProps): React.ReactElement {
	if (lines !== undefined && lines > 0) {
		return (
			<span className="rr-skeleton-stack" aria-hidden="true">
				{paragraphWidths(lines).map((lineWidth, index) => (
					<span key={index} className="rr-skeleton" style={{ width: lineWidth, height }} />
				))}
			</span>
		);
	}

	let classes = 'rr-skeleton';
	let style: CSSProperties = { width, height };
	if (circle) {
		classes += ' rr-skeleton--circle';
		style = { width, height: width };
	}

	return <span className={classes} style={style} aria-hidden="true" />;
}
