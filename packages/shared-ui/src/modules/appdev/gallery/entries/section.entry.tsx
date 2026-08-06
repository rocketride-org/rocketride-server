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
// SECTION / LABEL VALUE — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the Section + LabelValue record-body vocabulary. */

import React from 'react';
import { LabelValue, Section } from '../../../../components/section/Section';
import { StatusBadge } from '../../../../components/status-badge/StatusBadge';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a Section with LabelValue rows - the DetailPanel body idiom. */
const SectionDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<div style={{ maxWidth: 420 }}>
		<Section label={String(knobs.label)}>
			<LabelValue label="Name">chat.pipe</LabelValue>
			<LabelValue label="Task id" mono={Boolean(knobs.mono)}>rod.demo.chat</LabelValue>
			<LabelValue label="Status"><StatusBadge variant="success">Running</StatusBadge></LabelValue>
		</Section>
	</div>
);

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	const monoAttr = knobs.mono ? ' mono' : '';
	return `import { Section, LabelValue, StatusBadge } from 'shared';

<Section label="${String(knobs.label)}">
	<LabelValue label="Name">chat.pipe</LabelValue>
	<LabelValue label="Task id"${monoAttr}>rod.demo.chat</LabelValue>
	<LabelValue label="Status"><StatusBadge variant="success">Running</StatusBadge></LabelValue>
</Section>`;
};

/** The Section / LabelValue gallery entry. */
export const sectionEntry: IGalleryEntry = {
	id: 'section',
	name: 'Section / LabelValue',
	group: 'content',
	blurb: 'Uppercase section label with divider + fixed-width label/value rows - the DetailPanel body vocabulary. Wraps commonStyles.labelUppercase/divider.',
	knobs: [
		{ id: 'label', label: 'Section label', kind: 'text', defaultValue: 'Details' },
		{ id: 'mono', label: 'Mono value', kind: 'boolean', defaultValue: true },
	],
	demo: SectionDemo,
	code: buildCode,
	props: [
		{ name: 'label', type: 'string', dir: 'in', required: true, note: 'Section - uppercase section label (Section) / row label in the fixed-width left column (LabelValue).' },
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'Section body (typically LabelValue rows) / the row value.' },
		{ name: 'mono', type: 'boolean', dir: 'in', note: 'LabelValue only - render the value in a monospace face.' },
	],
};
