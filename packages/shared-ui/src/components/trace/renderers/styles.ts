// =============================================================================
// Shared styles for trace data renderers
// =============================================================================

import type { CSSProperties } from 'react';

export const RS = {
	section: {
		marginBottom: 6,
	} as CSSProperties,
	label: {
		fontSize: 10,
		fontWeight: 600,
		color: 'var(--rr-text-secondary)',
		textTransform: 'uppercase',
		letterSpacing: '0.04em',
		marginBottom: 3,
	} as CSSProperties,
	textBlock: {
		backgroundColor: 'var(--rr-bg-paper)',
		borderRadius: 4,
		padding: '6px 8px',
		fontSize: 12,
		lineHeight: 1.6,
		color: 'var(--rr-text-primary)',
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
		maxHeight: 200,
		overflow: 'auto',
	} as CSSProperties,
	kvRow: {
		display: 'flex',
		gap: 8,
		fontSize: 11,
		lineHeight: '16px',
	} as CSSProperties,
	kvKey: {
		color: 'var(--rr-text-secondary)',
		flexShrink: 0,
		minWidth: 70,
	} as CSSProperties,
	kvVal: {
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	kvMono: {
		color: 'var(--rr-text-primary)',
		fontFamily: 'var(--rr-font-mono, monospace)',
	} as CSSProperties,
	badge: {
		display: 'inline-block',
		padding: '1px 5px',
		borderRadius: 3,
		fontSize: 9,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: '0.03em',
	} as CSSProperties,
	historyItem: {
		padding: '2px 0',
		fontSize: 11,
		borderBottom: '1px solid var(--rr-border-subtle, rgba(0,0,0,0.04))',
	} as CSSProperties,
	historyRole: {
		color: 'var(--rr-text-secondary)',
		fontWeight: 500,
		marginRight: 4,
	} as CSSProperties,
	muted: {
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
		fontSize: 11,
	} as CSSProperties,
};
