// =============================================================================
// VIEWER STYLES — shared CSS-in-JS styles for all file viewers
// =============================================================================

import type { CSSProperties } from 'react';

export const viewerStyles = {
	/** Centered loading / error / unsupported message. */
	message: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--rr-text-secondary)',
		fontSize: 14,
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	/** Centered media container (images). */
	mediaContainer: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		overflow: 'auto',
		padding: 16,
		backgroundColor: 'var(--rr-bg-paper)',
	} as CSSProperties,

	/** Scrollable prose container (markdown, JSON). */
	prose: {
		flex: 1,
		overflow: 'auto',
		padding: '12px 24px',
		backgroundColor: 'var(--rr-bg-paper)',
	} as CSSProperties,
};
