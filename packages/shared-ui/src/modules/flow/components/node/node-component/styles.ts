// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Shared MUI sx-compatible style definitions for the NodeComponent tree.
 *
 * All visual properties (colors, fonts) reference --rr-* CSS custom
 * properties so the component adapts automatically to the host theme
 * (VS Code or standalone web).
 */

export const styles = {
	/** Root container for the node body (positioned relative for absolute children). */
	nodeContent: {
		position: 'relative',
	},

	/** 4px rounded top cap — provides the top border radius for the node card. */
	cornerCapTop: {
		height: '8px',
		backgroundColor: 'var(--rr-bg-paper)',
		borderRadius: '4px 4px 0 0',
	},

	/** Wrapper around the header section (NodeHeader + children). */
	headerWrapper: {
		position: 'relative',
		flex: 1,
	},

	/** Shared label text style used by lanes and header for consistent typography. */
	label: {
		letterSpacing: 0,
		lineHeight: 1,
		textAlign: 'left',
		overflow: 'hidden',
		whiteSpace: 'normal',
		display: '-webkit-box',
		WebkitLineClamp: 2,
		WebkitBoxOrient: 'vertical',
	},

	/** Tile container style for node content areas. */
	tile: {
		px: '0.6rem',
		py: '0.2rem',
		textAlign: 'left',
		backgroundColor: 'var(--rr-bg-paper)',
	},

	/** Tile label text — class type, description badges. */
	tileLabel: {
		fontSize: 'var(--rr-font-size-xs)',
		color: 'var(--rr-text-disabled)',
	},
};
