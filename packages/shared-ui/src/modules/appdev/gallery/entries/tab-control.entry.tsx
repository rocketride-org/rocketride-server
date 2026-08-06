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
// TAB CONTROL + TAB PANEL — GALLERY ENTRY
// =============================================================================

/**
 * Joint gallery entry for TabControl (the page-tabs strip) and TabPanel (the
 * always-mounted panel stack beneath it) - one entry because they are the two
 * halves of the same page-tabs pattern and share the ViewMenu entry shape.
 */

import React, { useState } from 'react';
import { TabControl } from 'shell';
import { TabPanel } from 'shell';
import { commonStyles } from 'shell/src/themes/styles';
import type { ViewMenu } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** One demo panel body - plain text so the pattern stays the focus. */
const PANEL_BODY_STYLE: React.CSSProperties = { ...commonStyles.textMuted, padding: '16px 4px' };

/** Live demo: strip + panel stack with local active-tab state. */
const TabControlDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [activeId, setActiveId] = useState('overview');

	// Menu rebuilt per render so the count knob applies immediately
	const menu: ViewMenu = {
		entries: [
			{ id: 'overview', label: 'Overview' },
			{ id: 'events', label: 'Events', count: knobs.count ? 48 : undefined },
			{ id: 'settings', label: 'Settings' },
		],
	};

	return (
		<div style={{ maxWidth: 560 }}>
			<TabControl
				menu={menu}
				activeId={activeId}
				onSelect={setActiveId}
				trailing={knobs.trailing ? <span style={{ ...commonStyles.fontMono, fontSize: 11, color: 'var(--rr-text-disabled)', alignSelf: 'center' }}>chat.pipe</span> : undefined}
			/>
			<TabPanel
				activeId={activeId}
				panels={{
					overview: { content: <div style={PANEL_BODY_STYLE}>Overview panel - stays mounted while the other tabs are active.</div> },
					events: { content: <div style={PANEL_BODY_STYLE}>Events panel - 48 events buffered.</div> },
					settings: { content: <div style={PANEL_BODY_STYLE}>Settings panel.</div> },
				}}
			/>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	const countAttr = knobs.count ? ', count: 48' : '';
	const trailingAttr = knobs.trailing ? '\n\ttrailing={<span>chat.pipe</span>}' : '';
	return `import { TabControl, TabPanel } from 'shared';

const menu = { entries: [
	{ id: 'overview', label: 'Overview' },
	{ id: 'events', label: 'Events'${countAttr} },
	{ id: 'settings', label: 'Settings' },
] };

<TabControl menu={menu} activeId={tab} onSelect={setTab}${trailingAttr} />
<TabPanel activeId={tab} panels={{
	overview: { content: <OverviewPanel /> },
	events: { content: <EventsPanel /> },
	settings: { content: <SettingsPanel /> },
}} />`;
};

/** The TabControl + TabPanel gallery entry. */
export const tabControlEntry: IGalleryEntry = {
	id: 'tab-control',
	name: 'TabControl + TabPanel',
	group: 'content',
	blurb: 'The page-tabs pattern: TabControl renders the strip at the very top of a view (above its ContentHeader); TabPanel renders the panel stack beneath it with every panel MOUNTED - inactive panels hide with display:none so state survives switches.',
	knobs: [
		{ id: 'count', label: 'Count badge', kind: 'boolean', defaultValue: true },
		{ id: 'trailing', label: 'Trailing slot', kind: 'boolean', defaultValue: false },
	],
	demo: TabControlDemo,
	code: buildCode,
	props: [
		{ name: 'menu', type: 'ViewMenu', dir: 'in', required: true, note: 'TabControl - the declared menu whose entries render as the strip tabs (id, label, count, severity).' },
		{ name: 'activeId', type: 'string', dir: 'in', required: true, note: 'Id of the active entry / visible panel (all other panels hide with display:none).' },
		{ name: 'trailing', type: 'ReactNode', dir: 'in', note: 'TabControl - right-aligned slot (e.g. an id note or expand icon).' },
		{ name: 'panels', type: 'Record<string, { content: ReactNode }>', dir: 'in', required: true, note: 'TabPanel - map of panel id to content. Hidden panels measure 0x0: canvases must lazy-mount on first activation.' },
		{ name: 'onSelect', type: '(id: string) => void', dir: 'out', required: true, note: 'TabControl - fired with an entry id when the user selects it.' },
	],
};
