// MIT License
//
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
// <Icon> — the design system's icon shapes
// =============================================================================
//
// The shell does not export an icon set to apps, and this app adds no npm
// packages, so the shapes the design system draws (its components/bundle.js,
// the same paths as Lucide) are ported here: 16px with a 1.75 stroke, or the
// 13px / 2.2 chip size. Colour is `currentColor`, so an icon takes the colour
// of the text beside it.
// =============================================================================

import React from 'react';

const PATHS = {
	check: <path d="M20 6 9 17l-5-5" />,
	x: <path d="M18 6 6 18M6 6l12 12" />,
	alert: (
		<>
			<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
			<path d="M12 9v4M12 17h.01" />
		</>
	),
	clock: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</>
	),
	minus: <path d="M5 12h14" />,
	search: (
		<>
			<circle cx="11" cy="11" r="7" />
			<path d="m20 20-3.5-3.5" />
		</>
	),
	copy: (
		<>
			<rect x="9" y="9" width="12" height="12" rx="2" />
			<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
		</>
	),
	external: <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />,
	play: <path d="M7 4.5v15l12-7.5z" />,
	rotate: (
		<>
			<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
			<path d="M3 3v5h5" />
		</>
	),
	stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
	database: (
		<>
			<ellipse cx="12" cy="5" rx="8" ry="3" />
			<path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
		</>
	),
	book: (
		<>
			<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" />
			<path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
		</>
	),
	bell: (
		<>
			<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
			<path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
		</>
	),
	inbox: (
		<>
			<path d="M22 12h-6l-2 3h-4l-2-3H2" />
			<path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1Z" />
		</>
	),
	download: <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />,
	upload: <path d="M12 21V9M7 14l5-5 5 5M5 3h14" />,
	gauge: (
		<>
			<path d="M12 14l4-4" />
			<path d="M3.3 19a10 10 0 1 1 17.4 0" />
		</>
	),
	chevron: <path d="m9 18 6-6-6-6" />,
	message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
	sliders: <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />,
	cpu: (
		<>
			<rect x="5" y="5" width="14" height="14" rx="2" />
			<path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" />
		</>
	),
	key: (
		<>
			<circle cx="7.5" cy="15.5" r="4.5" />
			<path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2" />
		</>
	),
} as const;

/** Every icon name the app can draw. */
export type IconName = keyof typeof PATHS;

/**
 * One icon.
 *
 * @param props.name - Which shape.
 * @param props.small - The 13px / 2.2-stroke size used inside chips.
 * @param props.label - An accessible name; without one the icon is decoration.
 * @returns The SVG.
 */
export const Icon: React.FC<{ name: IconName; small?: boolean; label?: string }> = ({ name, small, label }) => (
	<svg className={small ? 'dd-ic dd-ic--sm' : 'dd-ic'} viewBox="0 0 24 24" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
		{PATHS[name]}
	</svg>
);

/**
 * The same icon as SVG markup, for the grid's cell formatters, which build
 * DOM nodes rather than React elements.
 *
 * @param name - Which shape.
 * @param small - The chip size.
 * @returns The SVG markup.
 */
export function iconHtml(name: IconName, small = true): string {
	const raw: Record<IconName, string> = {
		check: '<path d="M20 6 9 17l-5-5"/>',
		x: '<path d="M18 6 6 18M6 6l12 12"/>',
		alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
		clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
		minus: '<path d="M5 12h14"/>',
		search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
		copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
		external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
		play: '<path d="M7 4.5v15l12-7.5z"/>',
		rotate: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
		stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
		database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
		book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
		bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
		inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1Z"/>',
		download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
		upload: '<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>',
		gauge: '<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
		chevron: '<path d="m9 18 6-6-6-6"/>',
		message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
		sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
		cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4"/>',
		key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2"/>',
	};
	return `<svg class="dd-ic${small ? ' dd-ic--sm' : ''}" viewBox="0 0 24 24" aria-hidden="true">${raw[name]}</svg>`;
}
