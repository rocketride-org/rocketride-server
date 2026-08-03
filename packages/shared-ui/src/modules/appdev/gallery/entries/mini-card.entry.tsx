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
// MINI CARD — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the MiniCard metric tile and its MiniContainer grid row. */

import React from 'react';
import { MiniCard, MiniContainer } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Maps the colour knob to a semantic token (default = primary text colour). */
const COLOR_TOKENS: Record<string, string | undefined> = {
	default: undefined,
	success: 'var(--rr-color-success)',
	warning: 'var(--rr-color-warning)',
	error: 'var(--rr-color-error)',
};

/** Live demo: a MiniContainer row - the first tile driven by the knob values. */
const MiniCardDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<MiniContainer>
		<MiniCard value={String(knobs.value)} label={String(knobs.label)} color={COLOR_TOKENS[String(knobs.color)]} />
		<MiniCard value="98.2%" label="Success rate" />
		<MiniCard value="14s" label="Avg duration" />
	</MiniContainer>
);

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	const colorAttr = knobs.color !== 'default' ? ` color="var(--rr-color-${String(knobs.color)})"` : '';
	return `import { MiniCard, MiniContainer } from 'shell';

<MiniContainer>
	<MiniCard value="${String(knobs.value)}" label="${String(knobs.label)}"${colorAttr} />
	<MiniCard value="98.2%" label="Success rate" />
	<MiniCard value="14s" label="Avg duration" />
</MiniContainer>`;
};

/** The MiniCard / MiniContainer gallery entry. */
export const miniCardEntry: IGalleryEntry = {
	id: 'mini-card',
	name: 'MiniCard / MiniContainer',
	group: 'content',
	blurb: 'Compact metric tile - big value (22px/700) over an uppercase label - laid out in equal columns by the MiniContainer grid row. The "1,284 / DOCUMENTS" tiles.',
	knobs: [
		{ id: 'value', label: 'Value', kind: 'text', defaultValue: '1,284' },
		{ id: 'label', label: 'Label', kind: 'text', defaultValue: 'Documents' },
		{ id: 'color', label: 'Value colour', kind: 'select', options: ['default', 'success', 'warning', 'error'], defaultValue: 'default' },
	],
	demo: MiniCardDemo,
	code: buildCode,
	props: [
		{ name: 'value', type: 'ReactNode', dir: 'in', required: true, note: 'The metric value (number, formatted string, or a custom node).' },
		{ name: 'label', type: 'string', dir: 'in', required: true, note: 'Caption beneath the value - uppercase by default.' },
		{ name: 'title', type: 'string', dir: 'in', note: 'Optional uppercase heading ABOVE the value; label may then be mixed case. Prefer plain label.' },
		{ name: 'color', type: 'string', dir: 'in', note: "Optional CSS colour for the value text (e.g. 'var(--rr-color-success)')." },
		{ name: 'columns', type: 'number', dir: 'in', note: 'MiniContainer - explicit column count; defaults to one column per child.' },
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'MiniContainer - the MiniCards to lay out (16px gaps).' },
	],
};
