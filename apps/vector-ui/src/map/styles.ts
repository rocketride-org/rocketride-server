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
// MAP - STYLES (inline style objects over shell tokens, shared by the map's components)
// =============================================================================
//
// Text is always --rr-text-primary (the secondary token is below 4.5:1 in
// RocketRide Dark); emphasis comes from size and weight. Focus rings use the
// accent and are injected once as a stylesheet, because inline styles cannot
// express :focus-visible.
// =============================================================================

import type { CSSProperties } from 'react';
import { ACCENT_TOKEN, OUTLINE_TOKEN } from './tokens';

const text: CSSProperties = { color: 'var(--rr-text-primary)', fontSize: 12.5, lineHeight: 1.45 };

/** Style objects. */
export const MAP_STYLES = {
	root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--rr-bg-default)', color: 'var(--rr-text-primary)' } as CSSProperties,
	body: { display: 'flex', flex: 1, minHeight: 0, gap: 0 } as CSSProperties,
	canvasColumn: { position: 'relative', flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' } as CSSProperties,
	side: { width: 340, maxWidth: '42%', minWidth: 260, borderLeft: '1px solid var(--rr-border)', background: 'var(--rr-bg-paper)', display: 'flex', flexDirection: 'column', minHeight: 0 } as CSSProperties,
	sideBody: { flex: 1, overflow: 'auto', padding: 12 } as CSSProperties,
	toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--rr-border)', background: 'var(--rr-bg-paper)' } as CSSProperties,
	group: { display: 'inline-flex', alignItems: 'center', gap: 6 } as CSSProperties,
	label: { ...text, fontWeight: 600, fontSize: 11.5 } as CSSProperties,
	text,
	small: { ...text, fontSize: 11.5 } as CSSProperties,
	heading: { ...text, fontSize: 13, fontWeight: 700, margin: '0 0 6px' } as CSSProperties,
	note: { ...text, fontSize: 11.5, margin: '4px 0' } as CSSProperties,
	mono: { fontFamily: 'var(--rr-font-mono, ui-monospace, monospace)', fontSize: 11.5 } as CSSProperties,
	select: { ...text, height: 28, borderRadius: 6, border: '1px solid var(--rr-border-input, var(--rr-border))', background: 'var(--rr-bg-default)', padding: '0 6px' } as CSSProperties,
	input: { ...text, height: 28, minWidth: 180, borderRadius: 6, border: '1px solid var(--rr-border-input, var(--rr-border))', background: 'var(--rr-bg-default)', padding: '0 8px' } as CSSProperties,
	button: { ...text, height: 28, padding: '0 10px', borderRadius: 6, border: '1px solid var(--rr-border-input, var(--rr-border))', background: 'var(--rr-bg-default)', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' } as CSSProperties,
	// The whole border shorthand (as `button` sets it): React warns when a toggle mixes border and borderColor.
	buttonPressed: { border: `1px solid var(${ACCENT_TOKEN})`, boxShadow: `inset 0 0 0 1px var(${ACCENT_TOKEN})` } as CSSProperties,
	buttonDisabled: { opacity: 0.55, cursor: 'not-allowed' } as CSSProperties,
	linkButton: { ...text, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', textDecoration: 'underline' } as CSSProperties,
	list: { listStyle: 'none', margin: 0, padding: 0 } as CSSProperties,
	row: { padding: '6px 0', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	tag: { ...text, fontSize: 10.5, fontWeight: 700, border: `1px solid var(${OUTLINE_TOKEN})`, borderRadius: 4, padding: '0 4px', marginLeft: 6 } as CSSProperties,
	tabs: { display: 'flex', flexWrap: 'wrap', gap: 2, padding: '6px 8px', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	tab: { ...text, fontSize: 11.5, fontWeight: 600, padding: '4px 8px', border: 'none', borderBottom: '2px solid transparent', background: 'none', cursor: 'pointer' } as CSSProperties,
	tabActive: { borderBottom: `2px solid var(${ACCENT_TOKEN})` } as CSSProperties,
	table: { ...text, width: '100%', borderCollapse: 'collapse' } as CSSProperties,
	th: { textAlign: 'left', fontWeight: 700, fontSize: 11.5, padding: '4px 6px', borderBottom: '1px solid var(--rr-border)', position: 'sticky', top: 0, background: 'var(--rr-bg-paper)' } as CSSProperties,
	td: { padding: '3px 6px', borderBottom: '1px solid var(--rr-border)', verticalAlign: 'top' } as CSSProperties,
	tooltip: { position: 'absolute', pointerEvents: 'none', maxWidth: 320, padding: '6px 8px', borderRadius: 6, background: 'var(--rr-bg-paper)', color: 'var(--rr-text-primary)', border: '1px solid var(--rr-border)', boxShadow: '0 2px 8px rgba(0,0,0,0.25)', fontSize: 12, lineHeight: 1.4, zIndex: 2 } as CSSProperties,
	legend: { padding: '8px 10px', borderTop: '1px solid var(--rr-border)', background: 'var(--rr-bg-paper)' } as CSSProperties,
	/**
	 * A colour swatch; an outlined colour gets the outline ring.
	 *
	 * @param colour - CSS colour.
	 * @param outlined - Whether the colour needs its outline.
	 * @returns The style.
	 */
	swatch(colour: string, outlined: boolean): CSSProperties {
		return { display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: colour, boxShadow: outlined ? `0 0 0 1px var(${OUTLINE_TOKEN})` : undefined, marginRight: 6, verticalAlign: 'middle', flex: 'none' };
	},
};

/** Id of the injected stylesheet. */
const STYLE_ID = 'vector-ui-map-style';

/** Rules inline styles cannot express. */
export const MAP_RULES = [
	`.vector-map :focus-visible { outline: 3px solid var(${ACCENT_TOKEN}, var(--rr-text-primary)); outline-offset: 2px; }`,
	`.vector-map-canvas:focus-visible { outline: 3px solid var(${ACCENT_TOKEN}, var(--rr-text-primary)); outline-offset: -3px; }`,
	'.vector-map button:disabled { opacity: 0.55; cursor: not-allowed; }',
	'@media (prefers-reduced-motion: reduce) { .vector-map * { transition: none !important; animation: none !important; } }',
].join('\n');

/** Inject the map rules once. */
export function ensureMapStyle(): void {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = MAP_RULES;
	document.head.appendChild(el);
}
