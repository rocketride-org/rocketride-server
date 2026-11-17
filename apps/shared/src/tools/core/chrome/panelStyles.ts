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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// TOOLS/CORE/CHROME — the sidebar panels' shared visual vocabulary
// =============================================================================
//
// One rhythm across every tool panel: nav sections, list rows, section
// labels, and action buttons all share these tokens so rows align
// column-for-column whichever tool tab is in front (the Explorer's own
// geometry is the reference).
// =============================================================================

import type { CSSProperties } from 'react';
import { commonStyles } from 'shell';

/** Row hover ground (list rows across every panel). */
export const PANEL_HOVER_BG = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))';

export const panelStyles = {
	/** No horizontal padding: the SidebarMenu inside carries its own
	 *  tree-list padding (2px 6px) — more here would break the shared left
	 *  rhythm with the Explorer rows. */
	navSection: {
		padding: '8px 0 12px',
		flexShrink: 0,
	} as CSSProperties,

	/** One tool body — its own full-height column so inner lists keep their
	 *  flex scrolling. */
	panelColumn: {
		display: 'flex',
		flexDirection: 'column' as const,
		height: '100%',
	} as CSSProperties,

	row: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		padding: '1px 8px',
		borderRadius: 5,
		fontSize: 13,
		lineHeight: '22px',
		cursor: 'pointer',
		userSelect: 'none' as const,
		position: 'relative' as const,
	} as CSSProperties,

	rowName: {
		...commonStyles.textEllipsis,
		flex: 1,
		minWidth: 0,
	} as CSSProperties,

	spacer: { flex: 1 } as CSSProperties,

	dot: (color: string): CSSProperties => ({
		width: 8,
		height: 8,
		borderRadius: '50%',
		backgroundColor: color,
		flexShrink: 0,
	}),

	actionBtn: (color: string): CSSProperties => ({
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		padding: '2px 4px',
		borderRadius: 3,
		color,
		flexShrink: 0,
		display: 'flex',
		alignItems: 'center',
	}),

	/** Section header — the Explorer's section-header treatment (same label
	 *  style and left offset; 24px line height matches the Explorer header's
	 *  action-button row height). */
	sectionLabel: {
		...commonStyles.labelUppercase,
		padding: '6px 12px 4px',
		lineHeight: '24px',
		flexShrink: 0,
	} as CSSProperties,

	/** Section list — the Explorer's tree-list padding, so rows align with
	 *  pipeline rows across the tool tabs. */
	sectionList: {
		padding: '2px 6px',
		flex: 1,
		minHeight: 0,
		overflowY: 'auto' as const,
	} as CSSProperties,

	/** Row icon in the 16px slot the generic glyph occupies. */
	rowIcon: {
		width: 16,
		height: 16,
		flexShrink: 0,
		objectFit: 'contain',
	} as CSSProperties,

	/** Muted empty line inside a section list. */
	emptyLine: {
		padding: '4px 10px',
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Placeholder body for not-yet-built panels. */
	comingSoon: {
		...commonStyles.textMuted,
		padding: 16,
		fontSize: 12,
		textAlign: 'center' as const,
	} as CSSProperties,
};
