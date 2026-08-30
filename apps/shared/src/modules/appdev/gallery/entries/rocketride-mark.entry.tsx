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
// ROCKETRIDE MARK — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the RocketRideMark brand icon. */

import React from 'react';
import { RocketRideMark } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: the mark at the knob-driven size. */
const RocketRideMarkDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => <RocketRideMark size={Number(knobs.size)} />;

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => `import { RocketRideMark } from 'shell';

<RocketRideMark${Number(knobs.size) !== 24 ? ` size={${Number(knobs.size)}}` : ''} />`;

/** The RocketRideMark gallery entry. */
export const rocketRideMarkEntry: IGalleryEntry = {
	id: 'rocketride-mark',
	name: 'RocketRideMark',
	group: 'content',
	blurb: 'The RocketRide rocket brand mark (icon only, no logotype): body fill follows the text colour, exhaust swoosh stays the fixed RocketRide red.',
	doc: `Use it wherever the product identifies itself — empty states, about panes, anonymous user cards. The body inherits \`currentColor\` (override with \`color\` / \`bodyColor\`); the swoosh is always brand red, so the mark reads correctly on any theme.`,
	knobs: [{ id: 'size', label: 'Size', kind: 'number', defaultValue: 48 }],
	demo: RocketRideMarkDemo,
	code: buildCode,
	props: [
		{ name: 'size', type: 'number', dir: 'in', note: 'Rendered width/height in px. Default 24.' },
		{ name: 'color', type: 'string', dir: 'in', note: 'Rocket body fill. Default currentColor.' },
		{ name: 'bodyColor', type: 'string', dir: 'in', note: 'Body fill alias; overrides color when set.' },
		{ name: 'className / style', type: 'string / CSSProperties', dir: 'in', note: 'Pass-through class name and inline style overrides.' },
	],
};
