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
// CARD — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the stock Card content group. */

import React from 'react';
import { Button } from 'shell';
import { Card } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a Card with header, optional header action, and body text. */
const CardDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<div style={{ maxWidth: 420 }}>
		<Card
			header={String(knobs.header)}
			headerActions={knobs.actions ? <Button variant="secondary" small onClick={() => undefined}>Refresh</Button> : undefined}
			onClick={knobs.clickable ? () => undefined : undefined}
		>
			Ingest finished for 1,284 documents. The next scheduled run starts at 02:00.
		</Card>
	</div>
);

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	const actionAttr = knobs.actions ? '\n\theaderActions={<Button variant="secondary" small onClick={refresh}>Refresh</Button>}' : '';
	const clickAttr = knobs.clickable ? '\n\tonClick={openRecord}' : '';
	return `import { Card${knobs.actions ? ', Button' : ''} } from 'shell';

<Card header={${JSON.stringify(String(knobs.header))}}${actionAttr}${clickAttr}>
	Ingest finished for 1,284 documents.
</Card>`;
};

/** The Card gallery entry. */
export const cardEntry: IGalleryEntry = {
	id: 'card',
	name: 'Card',
	group: 'content',
	blurb: 'Bordered content group: header row + body. onClick makes the whole card interactive (pointer, hover border shift, button semantics). Wraps commonStyles.card/cardHeader/cardBody.',
	knobs: [
		{ id: 'header', label: 'Header', kind: 'text', defaultValue: 'Last ingest' },
		{ id: 'actions', label: 'Header action', kind: 'boolean', defaultValue: true },
		{ id: 'clickable', label: 'Clickable', kind: 'boolean', defaultValue: false },
	],
	demo: CardDemo,
	code: buildCode,
	props: [
		{ name: 'header', type: 'ReactNode', dir: 'in', note: 'Header content - a plain string title or a custom node.' },
		{ name: 'headerActions', type: 'ReactNode', dir: 'in', note: 'Right side of the header row (actions / controls).' },
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'Card body content.' },
		{ name: 'toolbar', type: 'ReactNode', dir: 'in', note: 'Optional row beneath the header and above the body (filter/search strips), with its own divider.' },
		{ name: 'noBodyPadding', type: 'boolean', dir: 'in', note: 'Drop the body padding (for tables and media that fill the card).' },
		{ name: 'fill', type: 'boolean', dir: 'in', note: "Fill the parent height and flex the body into the remaining space - pair with noBodyPadding to host an internally-scrolling grid." },
		{ name: 'onClick', type: '() => void', dir: 'out', note: 'Makes the whole card clickable with pointer cursor, hover border shift, and button semantics.' },
	],
};
