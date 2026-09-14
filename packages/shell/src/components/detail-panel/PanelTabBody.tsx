// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PanelTabBody — the stock scroll wrapper for a DetailPanel tab.
 *
 * Under the interaction standard (2026-07-18) a tabbed DetailPanel's OUTER
 * body does not scroll — each tab panel owns its own overflow. Simple
 * Section/LabelValue stacks wrap their content in this component and get
 * correct scrolling in one line; a tab hosting a grid or viewer skips it and
 * lets that content own the scrolling instead.
 */

import React, { CSSProperties, ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link PanelTabBody} component. */
export interface IPanelTabBodyProps {
	/** The tab's content — typically a Section / LabelValue stack. */
	children: ReactNode;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Fill the non-scrolling tabbed body and own the vertical overflow.
	scroll: {
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a scrolling region filling a tabbed DetailPanel body.
 *
 * @param props - {@link IPanelTabBodyProps}.
 * @returns The scroll wrapper element.
 */
export function PanelTabBody({ children }: IPanelTabBodyProps): React.ReactElement {
	return <div style={styles.scroll}>{children}</div>;
}
