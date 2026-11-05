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
// VECTOR-UI — APP ICONS
// =============================================================================
//
// The shared Bx* set has no vector-store glyph, so the app carries its own,
// drawn to the same conventions (24px viewBox, currentColor, outline strokes).
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
 * Vector store icon (points near each other on two axes), for connections and documents.
 *
 * @param props - Icon props (optional style override).
 * @returns The SVG element.
 */
export function VectorIcon(props: IIconProps): ReactElement {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" style={{ ...defaultStyle, ...props.style }} aria-hidden="true">
			<path d="M4 20V4M4 20h16" />
			<circle cx="9.5" cy="14" r="1.8" />
			<circle cx="12.5" cy="9.5" r="1.8" />
			<circle cx="17" cy="11" r="1.8" />
			<path d="M10.6 12.6l1-1.6M14.2 10l1.1.4" />
		</svg>
	);
}

/**
 * Chevron for a folder that can be folded (points right; rotated when open).
 *
 * @param props - Icon props.
 * @returns The SVG element.
 */
export function ChevronIcon(props: IIconProps): ReactElement {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ ...defaultStyle, ...props.style }} aria-hidden="true">
			<path d="M9 6l6 6-6 6" />
		</svg>
	);
}
