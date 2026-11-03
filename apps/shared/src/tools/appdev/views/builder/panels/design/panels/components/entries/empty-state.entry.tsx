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
// EMPTY STATE — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the stock EmptyState placeholder. */

import React from 'react';
import { Button } from 'shell';
import { EmptyState } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: an EmptyState driven by the knob values. */
const EmptyStateDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<EmptyState
		title={String(knobs.title)}
		description={String(knobs.description) || undefined}
		action={knobs.action ? <Button onClick={() => undefined}>New pipeline</Button> : undefined}
	/>
);

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	const descriptionAttr = knobs.description ? `\n\tdescription="${String(knobs.description)}"` : '';
	const actionAttr = knobs.action ? '\n\taction={<Button onClick={createPipeline}>New pipeline</Button>}' : '';
	return `import { EmptyState } from 'shell';

<EmptyState
	title="${String(knobs.title)}"${descriptionAttr}${actionAttr}
/>`;
};

/** The EmptyState gallery entry. */
export const emptyStateEntry: IGalleryEntry = {
	id: 'empty-state',
	name: 'EmptyState',
	group: 'content',
	blurb: 'Icon + title + description + optional single action - the standard nothing-here placeholder for lists, panels, and panes.',
	knobs: [
		{ id: 'title', label: 'Title', kind: 'text', defaultValue: 'No pipelines yet' },
		{ id: 'description', label: 'Description', kind: 'text', defaultValue: 'Create your first pipeline to start processing documents.' },
		{ id: 'action', label: 'Action', kind: 'boolean', defaultValue: true },
	],
	demo: EmptyStateDemo,
	code: buildCode,
	props: [
		{ name: 'icon', type: 'ReactNode', dir: 'in', note: 'Optional icon rendered above the title (inherits the disabled text colour).' },
		{ name: 'title', type: 'string', dir: 'in', required: true, note: 'Heading line.' },
		{ name: 'description', type: 'string', dir: 'in', note: 'Optional supporting line beneath the title.' },
		{ name: 'action', type: 'ReactNode', dir: 'in', note: 'Optional single action (at most one Button).' },
	],
};
