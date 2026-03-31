// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * MUI sx-compatible style definitions for the NodeLanes component.
 *
 * All visual properties reference --rr-* CSS custom properties.
 */

import { styles as nodeStyles } from '../styles';

const styles = {
	/** Main lanes container — relative for InsideLines SVG overlay. */
	lanes: {
		padding: '0.25rem 0',
		position: 'relative',
		display: 'flex',
		backgroundColor: 'var(--rr-bg-paper)',
		borderTop: '1px solid var(--rr-border)',
	},

	/** Full-width container for the input/output lane columns. */
	connections: {
		width: '100%',
		alignItems: 'center',
	},

	/** Flex container for a single column of lanes (input or output). */
	connectionBox: {
		flex: 1,
	},

	/** Individual connection type row — positioned relative for handle placement. */
	connectionType: {
		position: 'relative',
		textTransform: 'capitalize',
		display: 'flex',
	},

	/** Lane body text styling — small, neutral colour. */
	body: {
		fontSize: 'var(--rr-font-size-xs)',
		color: 'var(--rr-text-disabled)',
	},

	/** Lane label — inherits shared label styles, adds padding and background. */
	label: {
		...nodeStyles.label,
		width: 'fit-content',
		backgroundColor: 'var(--rr-bg-paper)',
		padding: '0.3rem 0.6rem',
	},
};

export default styles;
