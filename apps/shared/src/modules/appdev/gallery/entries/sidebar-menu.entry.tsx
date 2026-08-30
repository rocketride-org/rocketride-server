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
// SIDEBAR MENU — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the SidebarMenu vertical menu list (sidebar content). */

import React, { useState } from 'react';
import { SidebarMenu } from 'shell';
import type { ViewMenu } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a menu with counts and a section, in a sidebar-width box. */
const SidebarMenuDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [activeId, setActiveId] = useState('overview');

	// Menu rebuilt per render so the badge knob applies immediately
	const menu: ViewMenu = {
		entries: [
			{ id: 'overview', label: 'Overview' },
			{ id: 'events', label: 'Events', count: knobs.badges ? 48 : undefined },
			{ id: 'errors', label: 'Errors', count: knobs.badges ? 3 : undefined, severity: knobs.badges ? 'error' : undefined },
			{
				id: 'pipelines',
				label: 'Pipelines',
				children: [
					{ id: 'chat', label: 'chat.pipe' },
					{ id: 'ingest', label: 'ingest.pipe' },
				],
			},
		],
	};

	return (
		<div style={{ width: knobs.collapsed ? 56 : 220, border: '1px solid var(--rr-border)', borderRadius: 6, background: 'var(--rr-bg-surface-alt)', padding: '6px 0' }}>
			<SidebarMenu menu={menu} activeId={activeId} onSelect={setActiveId} sectionLabel={String(knobs.sectionLabel) || undefined} collapsed={Boolean(knobs.collapsed)} />
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	const sectionAttr = knobs.sectionLabel ? `\n\tsectionLabel="${String(knobs.sectionLabel)}"` : '';
	const countAttr = knobs.badges ? ', count: 48' : '';
	return `import { SidebarMenu } from 'shell';

const menu = { entries: [
	{ id: 'overview', label: 'Overview' },
	{ id: 'events', label: 'Events'${countAttr} },
	{ id: 'pipelines', label: 'Pipelines', children: [
		{ id: 'chat', label: 'chat.pipe' },
	] },
] };

<SidebarMenu menu={menu} activeId={view} onSelect={setView}${sectionAttr} />`;
};

/** The SidebarMenu gallery entry. */
export const sidebarMenuEntry: IGalleryEntry = {
	id: 'sidebar-menu',
	name: 'SidebarMenu',
	group: 'sidebar',
	blurb: 'Standard vertical menu list on the shared ViewMenu entry shape - counts, severity badges, and one-level accordion sections. Apps mount any number inside the sidebar frame; it auto-iconifies when the shell sidebar collapses.',
	knobs: [
		{ id: 'sectionLabel', label: 'Section label', kind: 'text', defaultValue: 'chat.pipe' },
		{ id: 'badges', label: 'Count badges', kind: 'boolean', defaultValue: true },
		{ id: 'collapsed', label: 'Collapsed rail', kind: 'boolean', defaultValue: false },
	],
	demo: SidebarMenuDemo,
	code: buildCode,
	props: [
		{ name: 'menu', type: 'ViewMenu', dir: 'in', required: true, note: 'The declared menu whose entries render as the vertical list (id, label, count, severity, icon, disabled, children).' },
		{ name: 'activeId', type: 'string', dir: 'in', required: true, note: 'Id of the currently active entry (drawn as the brand-tinted pill).' },
		{ name: 'sectionLabel', type: 'string', dir: 'in', note: 'Section label above the menu, e.g. the owning document name. The label sits flush at indent 0; rows nest 10px beneath it (flush when no label).' },
		{ name: 'collapsed', type: 'boolean', dir: 'in', note: 'Icon-rail rendering; when omitted, falls back to the shell-provided useSidebarCollapsed context.' },
		{ name: 'onSelect', type: '(id: string) => void', dir: 'out', required: true, note: 'Fired with an entry id when the user selects it.' },
	],
};
