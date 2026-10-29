// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Divider — a hairline between groups of content, horizontal or vertical,
 * optionally with a short centered label ("or", "Advanced").
 *
 * Built on `.rr-divider` from components.css.
 */

import React, { ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link Divider} component. */
export interface IDividerProps {
	/** Vertical rule between inline items (toolbars). */
	vertical?: boolean;
	/** Short centered label (horizontal only). */
	label?: ReactNode;
	/** Purely visual: hide from screen readers. Defaults to false. */
	decorative?: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a separator line.
 *
 * @param props - {@link IDividerProps}.
 * @returns The separator element.
 */
export function Divider({ vertical = false, label, decorative = false }: IDividerProps): React.ReactElement {
	let role: string | undefined = 'separator';
	if (decorative) role = undefined;

	let orientation: 'horizontal' | 'vertical' | undefined;
	if (!decorative && vertical) orientation = 'vertical';

	if (label && !vertical) {
		return (
			<div className="rr-divider-labelled" role={role} aria-hidden={decorative || undefined}>
				<span className="rr-divider-labelled__text">{label}</span>
			</div>
		);
	}

	let classes = 'rr-divider';
	if (vertical) classes = 'rr-divider rr-divider--vertical';

	return <div className={classes} role={role} aria-orientation={orientation} aria-hidden={decorative || undefined} />;
}
