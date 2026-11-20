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
// MAP - COLOUR TOKENS (which shell token each thing on the map is drawn with)
// =============================================================================
//
// One place names them, so the renderer, the overlay, the legend and the
// contrast test (tests/a11y.contrast.map.test.ts) cannot drift apart. The map
// canvas sits on --rr-bg-default and its panels on --rr-bg-paper; every pair is
// measured against both, in all six shipped themes.
//
// Not --rr-brand for the accent: in RocketRide Light it is 1.9:1 on the page
// (Graph Explorer measured and replaced it the same way).
// =============================================================================

/** Surfaces the map and its panels sit on. */
export const MAP_SURFACES = ['--rr-bg-default', '--rr-bg-paper'] as const;

/** Selection ring, focus ring, query star, rays, neighbour links, lasso outline. Graphics: 3:1. */
export const ACCENT_TOKEN = '--rr-border-focus';

/** The 1 px outline on hovered, selected and low-contrast points. */
export const OUTLINE_TOKEN = '--rr-text-primary';

/** "Other" points (outside the legend's top categories) and hollow out-of-sample neighbours. Graphics: 3:1. */
export const OTHER_TOKEN = '--rr-text-secondary';

/** Text drawn on the map (tooltip, labels). 4.5:1. */
export const TEXT_TOKEN = '--rr-text-primary';

/**
 * The shell's chart colours, in assignment order (the order Graph Explorer uses:
 * the look-alike pairs of the light themes, yellow/orange and blue/purple, are
 * kept apart for small legends).
 */
export const CHART_COLOR_VARS = ['--rr-chart-blue', '--rr-chart-green', '--rr-chart-red', '--rr-chart-orange', '--rr-chart-purple', '--rr-chart-yellow'] as const;

/** WCAG 1.4.11: graphical objects. */
export const MIN_GRAPHIC_CONTRAST = 3;

/** WCAG 1.4.3: normal text. */
export const MIN_TEXT_CONTRAST = 4.5;

/** The resolved colours of the current theme (raw token text; may be rgba). */
export interface IMapPalette {
	mode: 'dark' | 'light';
	surfaces: { default: string; paper: string };
	accent: string;
	outline: string;
	other: string;
	text: string;
	/** In CHART_COLOR_VARS order. */
	chart: string[];
}

/** Fallbacks when a token is missing (an unthemed host). */
const FALLBACK = { dark: { bg: '#161616', paper: '#242424', accent: '#2f81f7', text: '#e6e6e6', other: '#a8a8a8' }, light: { bg: '#ffffff', paper: '#ffffff', accent: '#0078d4', text: '#1a1a1a', other: '#666666' } } as const;
const FALLBACK_CHART = ['#4263eb', '#2b8a3e', '#c92a2a', '#e67a2e', '#7048e8', '#e67700'];

/**
 * Read the palette through a token reader.
 *
 * @param read - Returns a token's value ('' when unset): getComputedStyle in the browser, a theme file in tests.
 * @returns The palette.
 */
export function readPalette(read: (token: string) => string): IMapPalette {
	const get = (token: string): string => String(read(token) ?? '').replace(/['"]/g, '').trim();
	const mode = get('--rr-palette-mode') === 'dark' ? 'dark' : 'light';
	const fb = FALLBACK[mode];
	return {
		mode,
		surfaces: { default: get('--rr-bg-default') || fb.bg, paper: get('--rr-bg-paper') || fb.paper },
		accent: get(ACCENT_TOKEN) || fb.accent,
		outline: get(OUTLINE_TOKEN) || fb.text,
		other: get(OTHER_TOKEN) || fb.other,
		text: get(TEXT_TOKEN) || fb.text,
		chart: CHART_COLOR_VARS.map((token, i) => get(token) || (FALLBACK_CHART[i] as string)),
	};
}
