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
// CHIP — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the stock Chip tag pill and its ChipAdd affordance. */

import React from 'react';
import { Chip, ChipAdd } from '../../../../components/chip/Chip';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a chip row with two fixed chips, the knob-driven chip, and the add affordance. */
const ChipDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
		<Chip label="read" />
		<Chip label="write" />
		<Chip label={String(knobs.label)} onRemove={knobs.removable ? () => undefined : undefined} />
		<ChipAdd label="Add permission" onClick={() => undefined} />
	</div>
);

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	const removeAttr = knobs.removable ? ' onRemove={() => removeTag(tag)}' : '';
	return `import { Chip, ChipAdd } from 'shared';

<Chip label="${String(knobs.label)}"${removeAttr} />
<ChipAdd label="Add permission" onClick={openPicker} />`;
};

/** The Chip gallery entry. */
export const chipEntry: IGalleryEntry = {
	id: 'chip',
	name: 'Chip / ChipAdd',
	group: 'content',
	blurb: 'Removable tag pill plus the matching add affordance - permissions, labels, and tag sets.',
	knobs: [
		{ id: 'label', label: 'Label', kind: 'text', defaultValue: 'deploy' },
		{ id: 'removable', label: 'Removable', kind: 'boolean', defaultValue: true },
	],
	demo: ChipDemo,
	code: buildCode,
	props: [
		{ name: 'label', type: 'string', dir: 'in', required: true, note: 'Tag label (Chip) / add-affordance label rendered after the plus glyph (ChipAdd).' },
		{ name: 'onRemove', type: '() => void', dir: 'out', note: 'Chip only - when provided, renders a remove glyph that calls this on activation.' },
		{ name: 'onClick', type: '() => void', dir: 'out', required: true, note: 'ChipAdd only - fired when the add affordance is activated.' },
	],
};
