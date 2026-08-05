// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * TabPanel — the page-body stack below a view's TabControl strip.
 *
 * A view with sub-views renders the stock TabControl strip at the top of
 * its content column and this component for the page bodies beneath it. Every
 * panel is mounted (so state such as a canvas's viewport survives switches)
 * and all but the active one are hidden with `display: none`.
 */

import React, { CSSProperties } from 'react';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Full-size relative wrapper around the panel stack.
	wrapper: {
		position: 'relative',
		width: '100%',
		height: '100%',
	} as CSSProperties,
	// One panel: fills the wrapper and scrolls its own content.
	panel: {
		width: '100%',
		height: '100%',
		overflow: 'auto',
		scrollbarWidth: 'thin',
		// The REAL token is --rr-bg-scrollbar-thumb (the old --rr-scrollbar-thumb
		// name never existed, so this always fell back to the hardcoded grey).
		scrollbarColor: 'var(--rr-bg-scrollbar-thumb, rgba(121, 121, 121, 0.4)) transparent',
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

/** One page body in the stack, keyed by its entry id in the panels map. */
export interface ITabPanelPanel {
	/** The panel's rendered content. */
	content: React.ReactNode;
}

/** Props for the {@link TabPanel} component. */
export interface ITabPanelProps {
	/** Map of panel id → { content }. Every panel is mounted; inactive ones hide. */
	panels: Record<string, ITabPanelPanel>;
	/** Id of the panel to show (all others are hidden with `display: none`). */
	activeId: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the panel stack (no pill bar) with the active panel visible.
 *
 * @param props - {@link ITabPanelProps}.
 * @returns The panel-stack element.
 */
export function TabPanel({ panels, activeId }: ITabPanelProps): React.ReactElement {
	return (
		<div style={styles.wrapper}>
			{Object.entries(panels).map(([id, panel]) => (
				/* tabpanel role completes the ARIA tab pattern whose tabs are
				   rendered by TabControl; hidden panels are aria-hidden. */
				<div key={id} role="tabpanel" aria-hidden={id !== activeId} style={{ ...styles.panel, display: id === activeId ? undefined : 'none' }}>
					{panel.content}
				</div>
			))}
		</div>
	);
}
