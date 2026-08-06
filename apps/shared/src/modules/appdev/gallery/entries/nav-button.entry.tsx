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
// NAV BUTTON — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the NavButton sidebar navigation row. */

import React from 'react';
import { NavButton, BxRocket } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: one NavButton in a sidebar-width column. */
const NavButtonDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<div style={{ width: knobs.collapsed ? 56 : 220 }}>
		<NavButton
			icon={BxRocket}
			label={String(knobs.label)}
			isActive={Boolean(knobs.isActive)}
			collapsed={Boolean(knobs.collapsed)}
			onClick={() => undefined}
		/>
	</div>
);

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	// Only non-default props appear, so the copied code stays minimal
	const attrs = [
		knobs.isActive ? ' isActive' : '',
		knobs.collapsed ? ' collapsed' : ' collapsed={collapsed}',
	].join('');
	return `import { NavButton, BxRocket } from 'shell';

<NavButton icon={BxRocket} label="${String(knobs.label)}"${attrs} onClick={openView} />`;
};

/** The NavButton gallery entry. */
export const navButtonEntry: IGalleryEntry = {
	id: 'nav-button',
	name: 'NavButton',
	group: 'sidebar',
	blurb: 'A single sidebar navigation row: icon + label when expanded, icon-only on the icon rail, with the active-item treatment.',
	doc: `The building block for custom sidebar navigation when \`SidebarMenu\` is too structured — one row per view, driven by the same \`collapsed\` state the frame provides (\`useSidebarCollapsed()\`).`,
	knobs: [
		{ id: 'label', label: 'Label', kind: 'text', defaultValue: 'Pipelines' },
		{ id: 'isActive', label: 'Active', kind: 'boolean', defaultValue: true },
		{ id: 'collapsed', label: 'Collapsed', kind: 'boolean', defaultValue: false },
	],
	demo: NavButtonDemo,
	code: buildCode,
	props: [
		{ name: 'icon', type: 'IconComponent', dir: 'in', required: true, note: 'Icon component to render (any Bx* icon).' },
		{ name: 'label', type: 'string', dir: 'in', required: true, note: 'Text label shown when expanded; also the tooltip fallback.' },
		{ name: 'isActive', type: 'boolean', dir: 'in', note: 'Marks this row as the currently active item.' },
		{ name: 'collapsed', type: 'boolean', dir: 'in', required: true, note: 'Icon-rail rendering - pass the frame\'s collapsed state.' },
		{ name: 'iconColor', type: 'string', dir: 'in', note: 'Override for the icon colour.' },
		{ name: 'title', type: 'string', dir: 'in', note: 'Tooltip override; falls back to label.' },
		{ name: 'onClick', type: '() => void', dir: 'out', note: 'Row activation handler.' },
	],
};
