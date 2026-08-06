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

/** Doc-only gallery entry for the shell-owned sidebar frame. */

import type { IGalleryEntry } from '../galleryTypes';

/** The Sidebar frame gallery entry. */
export const sidebarFrameEntry: IGalleryEntry = {
	id: 'sidebar-frame',
	name: 'Sidebar frame',
	group: 'chrome',
	blurb: 'The shell-owned sidebar container: fixed Header (brand + app label) on top, fixed Footer (user card) at the bottom, and a scrolling app-content slot between them, filled via useSidebarContent. No registered content = no sidebar, full-width client area. 260px expanded, 56px icon rail, drag-resizable.',
	docNote: 'Header and Footer are the frame - apps never mount, fill, or restyle them; the app fills only the middle slot with stock components (SidebarMenu, Explorer) and custom sections. Collapsed = still mounted: on the icon rail the slot keeps rendering and components read useSidebarCollapsed() to choose their icon form. Memoize the registered node - an inline node re-registers every render.',
	code: `import { useMemo } from 'react';
import { useSidebarContent } from 'shell';
import { SidebarMenu, useSidebarCollapsed } from 'shared';

// A free-form sidebar section that hides itself on the icon rail.
function RunningJobs() {
	const collapsed = useSidebarCollapsed();
	if (collapsed) return null;
	return <div>{/* custom section */}</div>;
}

function DocumentView({ page, setPage }) {
	// Build a stable node - the shell dedupes registrations by node identity.
	const sidebar = useMemo(() => (
		<>
			<SidebarMenu menu={PAGES} activeId={page} onSelect={setPage} sectionLabel="chat.pipe" />
			<RunningJobs />
		</>
	), [page, setPage]);

	// Mounts into the frame's scrolling slot; unmounting withdraws it.
	useSidebarContent(sidebar);
	return (/* ... the view's content ... */);
}`,
	props: [
		{ name: 'useSidebarContent', type: '(content: ReactNode | null) => void', dir: 'in', note: 'Declares the sidebar content for the calling view; pass null (or unmount) to withdraw. Last-writer-wins - the active tab\'s view naturally owns the slot.' },
		{ name: 'useSidebarCollapsed', type: '() => boolean', dir: 'out', note: 'Read inside registered sidebar content: true while the sidebar is on the icon rail. Returns false when no provider is mounted.' },
	],
};
