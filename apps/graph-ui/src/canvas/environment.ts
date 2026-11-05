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
// CANVAS - ENVIRONMENT HOOKS (reduced motion, theme mode) AND CANVAS STYLES
// =============================================================================

import { useEffect, useState } from 'react';
import { ACCENT_TOKEN, CANVAS_TEXT_TOKEN } from './tokens';

// =============================================================================
// REDUCED MOTION
// =============================================================================

/**
 * Whether the user asked the system for reduced motion. Tracks changes.
 *
 * @returns True when `prefers-reduced-motion: reduce` matches.
 */
export function useReducedMotion(): boolean {
	const query = '(prefers-reduced-motion: reduce)';
	const [reduced, setReduced] = useState<boolean>(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
	useEffect(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
		const media = window.matchMedia(query);
		const onChange = (): void => setReduced(media.matches);
		onChange();
		// Safari 13 only has the legacy addListener/removeListener pair.
		if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
		else media.addListener(onChange);
		return () => {
			if (typeof media.removeEventListener === 'function') media.removeEventListener('change', onChange);
			else media.removeListener(onChange);
		};
	}, []);
	return reduced;
}

// =============================================================================
// THEME MODE
// =============================================================================

/**
 * The shell's current palette mode (`--rr-palette-mode`), tracking theme switches.
 *
 * @returns `dark` or `light`.
 */
export function useThemeMode(): 'dark' | 'light' {
	const read = (): 'dark' | 'light' => {
		if (typeof document === 'undefined') return 'light';
		return getComputedStyle(document.documentElement).getPropertyValue('--rr-palette-mode').replace(/['"]/g, '').trim() === 'dark' ? 'dark' : 'light';
	};
	const [mode, setMode] = useState<'dark' | 'light'>(read);
	useEffect(() => {
		// The shell applies a theme by writing tokens onto the root element.
		const observer = new MutationObserver(() => setMode(read()));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
		setMode(read());
		return () => observer.disconnect();
	}, []);
	return mode;
}

// =============================================================================
// STYLES
// =============================================================================

/** Id of the injected stylesheet (guarantees a single insertion). */
const STYLE_ID = 'graph-ui-canvas-style';

/** Rules the inline styles cannot express: focus rings, selection, label halo, motion. */
export const CANVAS_RULES = [
	'.graph-ui-canvas .react-flow__node { cursor: pointer; }',
	'.graph-ui-canvas .react-flow__node:focus { outline: none; }',
	`.graph-ui-canvas .react-flow__node:focus-visible .graph-ui-circle { outline: 3px solid var(${ACCENT_TOKEN}, var(--rr-text-primary)); outline-offset: 3px; }`,
	'.graph-ui-canvas .graph-ui-circle { border: 1px solid var(--rr-text-primary); }',
	`.graph-ui-canvas .graph-ui-node[data-selected="true"] .graph-ui-circle { box-shadow: 0 0 0 3px var(${ACCENT_TOKEN}); }`,
	'.graph-ui-canvas .graph-ui-node[data-expanded="true"] .graph-ui-circle { border-width: 2px; }',
	// An element the database no longer answers for: dashed and faded, so it is not mistaken for a live one.
	'.graph-ui-canvas .graph-ui-node[data-stale="true"] .graph-ui-circle { border: 2px dashed var(--rr-text-primary); opacity: 0.55; }',
	'.graph-ui-canvas .graph-ui-caption { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); margin-top: 5px; max-width: 150px; font-size: 11.5px; line-height: 1.2; text-align: center; color: var(--rr-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; text-shadow: 0 0 3px var(--rr-bg-paper), 0 0 3px var(--rr-bg-paper); }',
	`.graph-ui-canvas .graph-ui-edge-label { font-size: 10px; fill: var(${CANVAS_TEXT_TOKEN}); paint-order: stroke; stroke: var(--rr-bg-paper); stroke-width: 3px; stroke-linejoin: round; user-select: none; }`,
	// Zoomed out or crowded: the label text is not drawn (the edge keeps its tooltip, accessible name, the inspector and the Table).
	'.graph-ui-canvas[data-edge-labels="off"] .graph-ui-edge-label { display: none; }',
	// Edges have no pointer behaviour (no click, no hover, not focusable): taking them out of hit-testing saves the browser a test against every one of them on each mouse move.
	'.graph-ui-canvas .graph-ui-edge-layer, .graph-ui-canvas .graph-ui-edge-layer * { pointer-events: none; }',
	// The edge layer sits behind the nodes: the viewport is a stacking context, so a negative index is behind its nodes and still in front of the page.
	'.graph-ui-canvas .react-flow__viewport-portal { z-index: -1; }',
	'.graph-ui-canvas .react-flow__attribution { display: none; }',
	// Layout results glide into place, but only while the container says so (never while dragging) and never under reduced motion.
	'@media (prefers-reduced-motion: no-preference) { .graph-ui-canvas.graph-ui-animating .react-flow__node { transition: transform 300ms ease; } }',
].join('\n');

/** Inject the canvas rules exactly once. */
export function ensureCanvasStyle(): void {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = CANVAS_RULES;
	document.head.appendChild(el);
}
