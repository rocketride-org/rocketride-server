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
// GRAPH-UI — APP ICONS
// =============================================================================
//
// The shared Bx* icon set has no graph glyphs, so the app carries its own
// minimal set, drawn to the same conventions (24px viewBox, currentColor,
// outline strokes) so they sit visually beside Bx icons.
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
 * Graph icon (three nodes joined by edges), for connections and graph documents.
 *
 * @param props - Icon props (optional style override).
 * @returns The SVG element.
 */
export function GraphIcon(props: IIconProps): ReactElement {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" style={{ ...defaultStyle, ...props.style }} aria-hidden="true">
			<circle cx="6" cy="7" r="2.6" />
			<circle cx="18" cy="7" r="2.6" />
			<circle cx="12" cy="18" r="2.6" />
			<path d="M8.6 7h6.8M7.3 9.3l3.4 6.4M16.7 9.3l-3.4 6.4" />
		</svg>
	);
}
