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
// CONTENT HEADER — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the stock ContentHeader page-title row. */

import React from 'react';
import { Button } from 'shell';
import { ContentHeader } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a ContentHeader driven by the knob values. */
const ContentHeaderDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<ContentHeader
		title={String(knobs.title)}
		subtitle={String(knobs.subtitle) || undefined}
		actions={knobs.actions ? <Button onClick={() => undefined}>New connection</Button> : undefined}
	/>
);

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	const subtitleAttr = knobs.subtitle ? `\n\tsubtitle="${String(knobs.subtitle)}"` : '';
	const actionsAttr = knobs.actions ? '\n\tactions={<Button onClick={createConnection}>New connection</Button>}' : '';
	return `import { ContentHeader } from 'shared';

<ContentHeader
	title="${String(knobs.title)}"${subtitleAttr}${actionsAttr}
/>`;
};

/** The ContentHeader gallery entry. */
export const contentHeaderEntry: IGalleryEntry = {
	id: 'content-header',
	name: 'ContentHeader',
	group: 'content',
	blurb: 'Page title (24/700) + subtitle (14, secondary) + right-aligned actions - the first element of every page, below the TabControl strip.',
	knobs: [
		{ id: 'title', label: 'Title', kind: 'text', defaultValue: 'Connections' },
		{ id: 'subtitle', label: 'Subtitle', kind: 'text', defaultValue: 'Manage the sources this workspace ingests from.' },
		{ id: 'actions', label: 'Actions', kind: 'boolean', defaultValue: true },
	],
	demo: ContentHeaderDemo,
	code: buildCode,
	props: [
		{ name: 'title', type: 'string', dir: 'in', required: true, note: 'Page / document title.' },
		{ name: 'subtitle', type: 'string', dir: 'in', note: 'Optional one-line description of the view.' },
		{ name: 'actions', type: 'ReactNode', dir: 'in', note: 'Optional right-aligned actions (primary Button at most once per view).' },
	],
};
