// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// VECTOR-UI — STYLES (built on commonStyles + --rr-* tokens)
// =============================================================================
//
// Every colour is a shell token. Text is always --rr-text-primary and the
// accent --rr-border-focus (see vector/colors.ts and tests/a11y.contrast).
// =============================================================================

import type { CSSProperties } from 'react';
import { commonStyles } from 'shell';
import { ACCENT_TOKEN, CONSOLE_TEXT_TOKEN, selectedRowBackground } from './vector/colors';

/** The visible focus ring every interactive element of the console uses. */
export const FOCUS_RING = `2px solid var(${ACCENT_TOKEN})`;

export const styles = {
	// Root fills the shell client pane; the header sits fixed at the top and
	// the content region below it scrolls.
	root: {
		...commonStyles.columnFill,
		color: `var(${CONSOLE_TEXT_TOKEN})`,
	} as CSSProperties,

	// Scrolling content column below the header (standard 20/24 gutters).
	content: {
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
		padding: '20px 24px 24px',
	} as CSSProperties,

	// Responsive card grid for the discovered stores.
	cardGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
		gap: 16,
	} as CSSProperties,

	// The line under a card: roles and flags.
	cardMeta: {
		display: 'flex',
		flexWrap: 'wrap',
		alignItems: 'center',
		gap: 6,
		marginTop: 6,
		fontSize: 12,
	} as CSSProperties,

	// A panel of the console (paper background, hairline border).
	panel: {
		display: 'flex',
		flexDirection: 'column',
		minHeight: 0,
		minWidth: 0,
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		overflow: 'hidden',
	} as CSSProperties,

	// A panel's title row.
	panelTitle: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '8px 12px',
		fontSize: 11,
		fontWeight: 700,
		letterSpacing: 0.6,
		textTransform: 'uppercase',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	// Small text (counts, footers): the same token, smaller.
	small: {
		fontSize: 12,
		lineHeight: 1.45,
	} as CSSProperties,

	// A chip: the tone is a decorative edge; the label carries the message.
	chip: (edge: string): CSSProperties => ({
		display: 'inline-flex',
		alignItems: 'center',
		gap: 4,
		padding: '1px 8px',
		borderRadius: 10,
		border: '1px solid var(--rr-border)',
		borderLeft: `4px solid ${edge}`,
		fontSize: 11.5,
		lineHeight: '18px',
		whiteSpace: 'nowrap',
	}),

	// A row of the directory (fixed height: the list is windowed by hand).
	row: (selected: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '0 8px 0 18px',
		height: 28,
		boxSizing: 'border-box',
		borderLeft: selected ? `3px solid var(${ACCENT_TOKEN})` : '3px solid transparent',
		background: selected ? selectedRowBackground() : 'transparent',
		fontSize: 12.5,
		cursor: 'pointer',
	}),

	// An icon button (trash): the icon draws in currentColor, the text token.
	iconButton: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 24,
		height: 24,
		padding: 3,
		border: 'none',
		borderRadius: 4,
		background: 'transparent',
		color: `var(${CONSOLE_TEXT_TOKEN})`,
		cursor: 'pointer',
	} as CSSProperties,

	// A plain text input in the shell's look.
	input: {
		flex: 1,
		minWidth: 0,
		padding: '5px 8px',
		fontSize: 12.5,
		color: `var(${CONSOLE_TEXT_TOKEN})`,
		background: 'var(--rr-bg-default)',
		border: '1px solid var(--rr-border-input)',
		borderRadius: 4,
	} as CSSProperties,
};
