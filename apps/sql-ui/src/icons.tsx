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
// SQL-UI — APP ICONS
// =============================================================================
//
// The shared Bx* icon set has no database/table glyphs, so the app carries its
// own minimal set, drawn to the same conventions (24px viewBox, currentColor,
// stroke-free filled paths where possible) so they sit visually beside Bx icons.
// =============================================================================

import type { CSSProperties, ReactElement } from 'react';

/** Shared props for the app's inline SVG icons. */
interface IIconProps {
	/** Optional inline style override (size defaults to 100% of the slot). */
	style?: CSSProperties;
}

// Default sizing matches the Bx* set: fill the slot the caller sizes.
const defaultStyle: CSSProperties = { width: '100%', height: '100%', display: 'block' };

/**
 * Database cylinder icon (outline), for connections and database entries.
 *
 * @param props - Icon props (optional style override).
 * @returns The SVG element.
 */
export function DatabaseIcon(props: IIconProps): ReactElement {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" style={{ ...defaultStyle, ...props.style }} aria-hidden="true">
			<ellipse cx="12" cy="5.5" rx="7" ry="2.8" />
			<path d="M5 5.5v13c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8v-13" />
			<path d="M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" />
		</svg>
	);
}

/**
 * Table grid icon (outline), for table entries and table documents.
 *
 * @param props - Icon props (optional style override).
 * @returns The SVG element.
 */
export function TableIcon(props: IIconProps): ReactElement {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" style={{ ...defaultStyle, ...props.style }} aria-hidden="true">
			<rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
			<path d="M3.5 9.5h17" />
			<path d="M10 9.5v10" />
		</svg>
	);
}
