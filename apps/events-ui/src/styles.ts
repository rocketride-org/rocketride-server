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
// EVENTS-UI — STYLES (built on commonStyles + --rr-* tokens)
// =============================================================================

import type { CSSProperties } from 'react';
import { commonStyles } from 'shell';

export const styles = {
	// ── View layout ──────────────────────────────────────────────────────────
	// Root fills the shell client pane; the ContentHeader sits fixed at the top
	// and the content region below it scrolls.
	root: {
		...commonStyles.columnFill,
	} as CSSProperties,

	// Content column below the header: a definite-height flex column (standard
	// 20/24 gutters). The metric row and capture card stay at natural height;
	// the grid fills the remaining space and scrolls internally, so the page
	// itself never scrolls.
	content: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
		padding: '20px 24px 24px',
		overflow: 'hidden',
	} as CSSProperties,

	// A non-growing row in the content column (metrics, capture card).
	staticRow: {
		flexShrink: 0,
	} as CSSProperties,

	// The event grid fills the remaining column height (its Card uses `fill`,
	// and the grid scrolls internally rather than paginating).
	gridFill: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,
};

// =============================================================================
// EVENT TYPE COLORS
// =============================================================================

/**
 * DAP event name to display color, from the `--rr-chart-*` set and semantic
 * tokens (never raw hex) so the coloring stays legible across every theme. The
 * grid's Type column and the detail-panel header both read this map.
 */
const EVENT_COLORS: Record<string, string> = {
	apaevt_status_update: 'var(--rr-chart-blue)',
	apaevt_task: 'var(--rr-chart-green)',
	apaevt_flow: 'var(--rr-chart-orange)',
	apaevt_output: 'var(--rr-chart-purple)',
	apaevt_detail: 'var(--rr-chart-red)',
	apaevt_sse: 'var(--rr-color-info)',
	apaevt_dashboard: 'var(--rr-color-success)',
	apaevt_billing: 'var(--rr-chart-yellow)',
	apaevt_status_upload: 'var(--rr-chart-purple)',
};

/**
 * Resolve a DAP event name to its display color, falling back to the secondary
 * text token for unmapped names.
 *
 * @param eventName - The DAP event name.
 * @returns A `--rr-*` CSS color value.
 */
export function eventColor(eventName: string): string {
	return EVENT_COLORS[eventName] ?? 'var(--rr-text-secondary)';
}
