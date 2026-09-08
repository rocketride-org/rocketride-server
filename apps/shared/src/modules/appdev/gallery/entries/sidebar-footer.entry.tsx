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
// SIDEBAR FOOTER — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the unified SidebarFooter user card + popup menu. */

import React from 'react';
import { SidebarFooter, BxCog, BxBookOpen } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: the footer in a sidebar-width column with a sample menu. */
const SidebarFooterDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<div style={{ width: knobs.collapsed ? 56 : 240 }}>
		<SidebarFooter
			collapsed={Boolean(knobs.collapsed)}
			userName={String(knobs.userName) || undefined}
			userEmail={String(knobs.userName) ? 'rod@example.com' : undefined}
			onOpenDocs={() => undefined}
			menuItems={[
				{ id: 'settings', label: 'Settings', icon: BxCog, onClick: () => undefined },
				{
					id: 'theme', label: 'Theme', icon: BxBookOpen, submenu: [
						{ id: 'dark', label: 'Dark', checked: true, onClick: () => undefined },
						{ id: 'light', label: 'Light', onClick: () => undefined },
					],
				},
				{ id: 'status', label: 'Cloud', statusText: 'Connected', statusState: 'connected', dividerBefore: true },
			]}
		/>
	</div>
);

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => `import { SidebarFooter, BxCog } from 'shell';

<SidebarFooter
	collapsed={${String(Boolean(knobs.collapsed))}}
	userName=${knobs.userName ? `"${String(knobs.userName)}"` : '{user?.name}'}
	userEmail={user?.email}
	onOpenDocs={openDocs}
	menuItems={[
		{ id: 'settings', label: 'Settings', icon: BxCog, onClick: openSettings },
		{ id: 'theme', label: 'Theme', submenu: themeItems },
		{ id: 'status', label: 'Cloud', statusText: 'Connected', statusState: 'connected', dividerBefore: true },
	]}
/>`;

/** The SidebarFooter gallery entry. */
export const sidebarFooterEntry: IGalleryEntry = {
	id: 'sidebar-footer',
	name: 'SidebarFooter',
	group: 'sidebar',
	blurb: 'The unified sidebar footer: announcements ticker, optional Documentation link, the user card (or rocket branding when anonymous), and a popup menu with flyout submenus.',
	doc: `One footer for every host — the cloud shell and the VS Code sidebar render the same component with host-specific \`menuItems\`. The trigger row shows avatar + name/email when signed in and rocket branding when not; clicking it opens a portalled popup with click-to-open flyout submenus, checkmarks for radio-style choices, status rows with connection dots, and section headers.

In the hosted cloud the SHELL renders it inside the sidebar frame — apps only meet it directly when building a standalone host's sidebar.`,
	knobs: [
		{ id: 'collapsed', label: 'Collapsed', kind: 'boolean', defaultValue: false },
		{ id: 'userName', label: 'User name', kind: 'text', defaultValue: 'Rod Christensen' },
	],
	demo: SidebarFooterDemo,
	code: buildCode,
	props: [
		{ name: 'collapsed', type: 'boolean', dir: 'in', required: true, note: 'Icon-only rendering while the sidebar is on the icon rail.' },
		{ name: 'userName', type: 'string', dir: 'in', note: 'User display name; drives the avatar initials. Absent = anonymous branding.' },
		{ name: 'userEmail', type: 'string', dir: 'in', note: 'User email, shown below the name.' },
		{ name: 'onOpenDocs', type: '() => void', dir: 'out', note: 'When provided, shows the Documentation link wired to this handler.' },
		{ name: 'menuItems', type: 'SidebarFooterMenuItem[]', dir: 'in', note: 'Host-specific popup menu items, rendered in order.' },
	],
	sections: [
		{
			label: 'SidebarFooterMenuItem',
			rows: [
				{ name: 'id / label', type: 'string', dir: 'in', required: true, note: 'Stable key and display label.' },
				{ name: 'icon', type: 'IconComponent', dir: 'in', note: 'Icon rendered before the label.' },
				{ name: 'onClick', type: '() => void', dir: 'out', note: 'Leaf-item activation handler.' },
				{ name: 'submenu', type: 'SidebarFooterMenuItem[]', dir: 'in', note: 'Nested items - clicking opens a flyout submenu instead of firing onClick.' },
				{ name: 'checked', type: 'boolean', dir: 'in', note: 'Checkmark for radio-style selections (e.g. the active theme).' },
				{ name: 'statusText / statusState', type: "string / 'connected' | 'connecting' | 'disconnected'", dir: 'in', note: 'Secondary status line plus the colored dot that goes with it.' },
				{ name: 'dividerBefore / header', type: 'boolean', dir: 'in', note: 'Divider above this item / render as a non-clickable section header.' },
			],
		},
	],
};
