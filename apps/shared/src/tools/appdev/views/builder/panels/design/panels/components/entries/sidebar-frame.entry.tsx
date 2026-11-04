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
const SidebarFrameDemo: React.FC<IGalleryDemoProps> = () => (
	<FrameSchematic highlight={['sidebarHeader', 'sidebarSlot', 'sidebarFooter']} />
);

/** The Sidebar frame gallery entry. */
export const sidebarFrameEntry: IGalleryEntry = {
	id: 'sidebar-frame',
	name: 'Sidebar frame',
	group: 'chrome',
	blurb: 'The shell-owned sidebar container: fixed Header and Footer around one scrolling app-content slot, filled via the AppLayout sidebar prop.',
	doc: `The frame is three vertical zones. **Header** (brand + app label) and **Footer** (user card + menu) belong to the shell; the **slot** between them is the one app-fillable region: the \`sidebar\` prop of the app's root \`<AppLayout>\`, filled with stock components (\`SidebarMenu\`, \`Explorer\`) plus custom sections.

**Three chromes.** \`rocketride\` is the classic single column (260px expanded, 56px icon rail, drag-resizable) and is what a bare \`sidebar\` prop renders. Declaring \`sidebarViews\` as well switches to \`vscode\` by default: a fixed activity rail (one icon per view container) beside a resizable panel; clicking the active icon toggles the panel, and the panel never iconifies. \`sidebarMode\` selects \`cursor\` (the same panel with the container switcher as a horizontal icon strip across the panel top; closed, a slim reopen strip remains) or opts a view-declaring app back to \`rocketride\`.

A view container without its own \`content\` shares the registered \`sidebar\` node, which reads \`useSidebarActiveView()\` to present the selected view (one data owner behind N rail icons). The **Sidebar layout** user setting can override the app's choice; the override applies only to apps that declare rail views. Below the compact breakpoint every mode renders the same drawer.

No \`sidebar\` prop = a one-column app with no sidebar at all; the client area spans full width.

**Collapsed is still mounted**: on the classic icon rail the slot keeps rendering and components read \`useSidebarCollapsed()\` to choose their icon form.`,
	docNote: 'Apps never mount, fill, or restyle the Header and Footer. Memoize the sidebar node - an inline node re-registers every render.',
	demo: SidebarFrameDemo,
	code: `import { useMemo, useState } from 'react';
import { AppLayout, SidebarMenu, useSidebarCollapsed, useSidebarActiveView } from 'shell';
import { Files, MessageSquare } from 'lucide-react';

// A free-form sidebar section that hides itself on the classic icon rail.
function RunningJobs() {
	const collapsed = useSidebarCollapsed();
	if (collapsed) return null;
	return <div>{/* custom section */}</div>;
}

export default function MyApp() {
	const [page, setPage] = useState('documents');
	// Build a stable node - the shell dedupes registrations by node identity.
	// Under 'vscode'/'cursor' this ONE node serves every container without its
	// own content: read the active view and present accordingly.
	const sidebar = useMemo(() => <SharedSidebar page={page} onSelect={setPage} />, [page]);

	// View containers - the rail icons ('vscode') / tab strip ('cursor').
	// No content on either: both share the registered sidebar node above.
	const views = useMemo(() => [
		{ id: 'files', title: 'Files', icon: <Files size={20} />, isDefault: true },
		{ id: 'chat', title: 'Chat', icon: <MessageSquare size={20} /> },
	], []);

	return (
		<AppLayout sidebar={sidebar} sidebarMode="vscode" sidebarViews={views} showStatus>
			{/* ... the app's content ... */}
		</AppLayout>
	);
}

function SharedSidebar({ page, onSelect }) {
	// Null = classic frame (no rail): fall back to the one-column form.
	const active = useSidebarActiveView();
	if (active?.activeViewId === 'chat') return <div>{/* chat view */}</div>;
	return (
		<>
			<SidebarMenu menu={PAGES} activeId={page} onSelect={onSelect} sectionLabel="chat.pipe" />
			<RunningJobs />
		</>
	);
}`,
	propsLabel: 'Hooks',
	props: [
		{ name: 'AppLayout sidebar', type: 'ReactNode', dir: 'in', note: 'The scrolling portion of the sidebar column. Present = two-column app; absent = one-column, no sidebar chrome.' },
		{ name: 'AppLayout sidebarMode', type: "'rocketride' | 'vscode' | 'cursor'", dir: 'in', note: "The sidebar chrome. Declaring sidebarViews defaults to 'vscode'; 'rocketride' opts back to the classic column. 'vscode'/'cursor' need a non-empty sidebarViews or the shell clamps back." },
		{ name: 'AppLayout sidebarViews', type: 'SidebarViewContainer[]', dir: 'in', note: "View containers behind the richer chromes - id, title, icon, optional content/badge/order/isDefault. A container without content shares the sidebar node. Ignored by 'rocketride'." },
		{ name: 'useSidebarActiveView', type: '() => SidebarActiveView | null', dir: 'out', note: 'Read inside a shared sidebar node: the active view container id (and a setter), so one node can present whichever view the rail selected. Null when no provider is mounted.' },
		{ name: 'useSidebarCollapsed', type: '() => boolean', dir: 'out', note: 'Read inside the sidebar node: true while the classic sidebar is on the icon rail. Returns false when no provider is mounted.' },
		{ name: 'SidebarCollapsedGate', type: '{ children: ReactNode }', dir: 'in', note: 'Stock wrapper that renders its children only while the sidebar is expanded - for free-form content with no icon-rail form.' },
	],
};
