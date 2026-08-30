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
// SIDEBAR FRAME — GALLERY ENTRY (DOC-ONLY, HOST CHROME)
// =============================================================================

/** Gallery entry for the shell-owned sidebar frame. */

import React from 'react';
import type { IGalleryDemoProps, IGalleryEntry } from '../galleryTypes';
import { FrameSchematic } from './demos/FrameSchematic';

/** Schematic demo: the sidebar's three vertical zones. */
const SidebarFrameDemo: React.FC<IGalleryDemoProps> = () => <FrameSchematic highlight={['sidebarHeader', 'sidebarSlot', 'sidebarFooter']} />;

/** The Sidebar frame gallery entry. */
export const sidebarFrameEntry: IGalleryEntry = {
	id: 'sidebar-frame',
	name: 'Sidebar frame',
	group: 'chrome',
	blurb: 'The shell-owned sidebar container: fixed Header and Footer around one scrolling app-content slot, filled via the AppLayout sidebar prop.',
	doc: `The frame is three vertical zones. **Header** (brand + app label) and **Footer** (user card + menu) belong to the shell; the **slot** between them is the one app-fillable region — the \`sidebar\` prop of the app's root \`<AppLayout>\`, filled with stock components (\`SidebarMenu\`, \`Explorer\`) plus custom sections.

Sizing: 260px expanded, 56px icon rail, drag-resizable. No \`sidebar\` prop = a one-column app with no sidebar at all — the client area spans full width.

**Collapsed is still mounted** — on the icon rail the slot keeps rendering and components read \`useSidebarCollapsed()\` to choose their icon form.`,
	docNote: 'Apps never mount, fill, or restyle the Header and Footer. Memoize the sidebar node - an inline node re-registers every render.',
	demo: SidebarFrameDemo,
	code: `import { useMemo, useState } from 'react';
import { AppLayout, SidebarMenu, useSidebarCollapsed } from 'shell';

// A free-form sidebar section that hides itself on the icon rail.
function RunningJobs() {
	const collapsed = useSidebarCollapsed();
	if (collapsed) return null;
	return <div>{/* custom section */}</div>;
}

export default function MyApp() {
	const [page, setPage] = useState('documents');
	// Build a stable node - the shell dedupes registrations by node identity.
	const sidebar = useMemo(() => (
		<>
			<SidebarMenu menu={PAGES} activeId={page} onSelect={setPage} sectionLabel="chat.pipe" />
			<RunningJobs />
		</>
	), [page]);

	return (
		<AppLayout sidebar={sidebar} showStatus>
			{/* ... the app's content ... */}
		</AppLayout>
	);
}`,
	propsLabel: 'Hooks',
	props: [
		{ name: 'AppLayout sidebar', type: 'ReactNode', dir: 'in', note: 'The scrolling portion of the sidebar column. Present = two-column app; absent = one-column, no sidebar chrome.' },
		{ name: 'useSidebarCollapsed', type: '() => boolean', dir: 'out', note: 'Read inside the sidebar node: true while the sidebar is on the icon rail. Returns false when no provider is mounted.' },
	],
};
