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
// DETAIL PANEL — GALLERY ENTRY
// =============================================================================

/**
 * Gallery entry for the DetailPanel record drawer. The demo anchors the
 * drawer INSIDE the demo stage via `contained` (the stage provides the
 * positioned, overflow-hidden host surface), so opening it never covers the
 * gallery itself - which is also exactly how contained drawers behave inside
 * the Account dialog.
 */

import React, { useState } from 'react';
import { Button } from 'shell';
import { DetailPanel } from 'shell';
import { LabelValue, Section } from 'shell';
import { StatusBadge } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a contained DetailPanel opened from a button on the stage. */
const DetailPanelDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [open, setOpen] = useState(false);
	return (
		// The contained drawer's host surface: positioned + overflow hidden
		<div style={{ position: 'relative', overflow: 'hidden', height: 340, border: '1px dashed var(--rr-border)', borderRadius: 6, padding: 16 }}>
			<Button onClick={() => setOpen(true)}>Open record</Button>
			<DetailPanel
				open={open}
				onClose={() => setOpen(false)}
				title="chat.pipe"
				subtitle="Pipeline - deployed 2 hours ago"
				side={knobs.side as 'right' | 'bottom'}
				contained
				footer={knobs.footer ? (
					<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
						<Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
						<Button onClick={() => setOpen(false)}>Save</Button>
					</div>
				) : undefined}
			>
				<Section label="Details">
					<LabelValue label="Name">chat.pipe</LabelValue>
					<LabelValue label="Task id" mono>rod.demo.chat</LabelValue>
					<LabelValue label="Status"><StatusBadge variant="success">Running</StatusBadge></LabelValue>
				</Section>
			</DetailPanel>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	const sideAttr = knobs.side !== 'right' ? `\n\tside="${String(knobs.side)}"` : '';
	const footerAttr = knobs.footer ? '\n\tfooter={<><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={save}>Save</Button></>}' : '';
	return `import { DetailPanel, Section, LabelValue } from 'shell';

<DetailPanel
	open={open}
	onClose={() => setOpen(false)}
	title="chat.pipe"
	subtitle="Pipeline - deployed 2 hours ago"${sideAttr}${footerAttr}
>
	<Section label="Details">
		<LabelValue label="Name">chat.pipe</LabelValue>
	</Section>
</DetailPanel>`;
};

/** The DetailPanel gallery entry. */
export const detailPanelEntry: IGalleryEntry = {
	id: 'detail-panel',
	name: 'DetailPanel / PanelTabBody',
	group: 'content',
	blurb: 'THE record panel: one slide-over surface for inspect / edit / create - EntityHeader + optional tabs + sectioned body + footer verb row. Stacks, resizes, and can anchor contained to the record-owning surface (as this demo does).',
	doc: `With \`tabs\`, the panel's outer body does not scroll — each tab owns its own overflow. Wrap every tab's content in \`PanelTabBody\` (the one-line stock scroll wrapper) to get that right.`,
	knobs: [
		{ id: 'side', label: 'Side', kind: 'select', options: ['right', 'bottom'], defaultValue: 'right' },
		{ id: 'footer', label: 'Footer verbs', kind: 'boolean', defaultValue: true },
	],
	demo: DetailPanelDemo,
	code: buildCode,
	props: [
		{ name: 'open', type: 'boolean', dir: 'in', required: true, note: 'Whether the drawer is open. When false the component renders nothing.' },
		{ name: 'title', type: 'string', dir: 'in', required: true, note: 'Entity title - 17px/700.' },
		{ name: 'subtitle', type: 'string', dir: 'in', note: 'Secondary line under the title.' },
		{ name: 'avatar', type: 'ReactNode', dir: 'in', note: '42px round avatar/icon slot at the start of the EntityHeader.' },
		{ name: 'tabs', type: 'ViewMenuEntry[]', dir: 'in', note: 'Optional tab strip (same entry shape as the ViewMenu renderers), paired with activeTab / onTabSelect.' },
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'Body content - composed from Section / LabelValue / Chip / StatusBadge / MiniContainer / Button.' },
		{ name: 'footer', type: 'ReactNode', dir: 'in', note: 'Fixed action row pinned below the scrolling body (Save / Cancel / destructive verbs).' },
		{ name: 'side', type: "'right' | 'bottom'", dir: 'in', note: "Slide edge - 'right' (default) full-height drawer, 'bottom' full-width tray for wide ambient content." },
		{ name: 'width', type: 'number', dir: 'in', note: "Drawer width in px (side 'right' only)." },
		{ name: 'height', type: 'number', dir: 'in', note: "Tray height in px (side 'bottom' only)." },
		{ name: 'contained', type: 'boolean', dir: 'in', note: 'Anchor to the nearest positioned ancestor instead of the viewport - the host surface must be position:relative with overflow:hidden.' },
		{ name: 'resizable', type: 'boolean', dir: 'in', note: 'Growing-edge drag resizing (ON by default; pass false to opt out).' },
		{ name: 'flushBody', type: 'boolean', dir: 'in', note: 'Body hosts a full View that owns its own scrolling - the body becomes a definite, non-scrolling flex box with no padding.' },
		{ name: 'onClose', type: '() => void', dir: 'out', required: true, note: 'Fired when the user dismisses the drawer (close glyph or Escape).' },
		{ name: 'onTabSelect', type: '(id: string) => void', dir: 'out', note: 'Fired with a tab id when the user selects a tab.' },
	],
	sections: [
		{
			label: 'PanelTabBody',
			rows: [
				{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'One tab\'s content - typically a Section / LabelValue stack. The wrapper owns the tab\'s scrolling.' },
			],
		},
	],
};
