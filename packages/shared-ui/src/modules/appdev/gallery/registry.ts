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
// COMPONENT GALLERY — ENTRY REGISTRY
// =============================================================================

/**
 * The ordered gallery registry: group declarations plus every entry, in the
 * style guide's stock-table order (host chrome, sidebar content, then content
 * components alphabetically). Adding a component to the gallery = writing its
 * entry file under `entries/` and appending it here.
 */

import type { GalleryGroup, IGalleryEntry } from './galleryTypes';

// --- Host chrome (doc-only) --------------------------------------------------
import { docTabsEntry } from './entries/doc-tabs.entry';
import { overlaySystemEntry } from './entries/overlay-system.entry';
import { sidebarFrameEntry } from './entries/sidebar-frame.entry';
import { statusBarEntry } from './entries/status-bar.entry';

// --- Sidebar content ---------------------------------------------------------
import { explorerEntry } from './entries/explorer.entry';
import { sidebarMenuEntry } from './entries/sidebar-menu.entry';

// --- Content components ------------------------------------------------------
import { bannerEntry } from './entries/banner.entry';
import { buttonEntry } from './entries/button.entry';
import { cardEntry } from './entries/card.entry';
import { chatViewEntry } from './entries/chat-view.entry';
import { chipEntry } from './entries/chip.entry';
import { connectionCardEntry } from './entries/connection-card.entry';
import { contentHeaderEntry } from './entries/content-header.entry';
import { dataGridEntry } from './entries/data-grid.entry';
import { detailPanelEntry } from './entries/detail-panel.entry';
import { dropZoneEntry } from './entries/drop-zone.entry';
import { emptyStateEntry } from './entries/empty-state.entry';
import { inputFieldEntry } from './entries/input-field.entry';
import { miniCardEntry } from './entries/mini-card.entry';
import { sectionEntry } from './entries/section.entry';
import { statusBadgeEntry } from './entries/status-badge.entry';
import { tabControlEntry } from './entries/tab-control.entry';
import { toggleGroupEntry } from './entries/toggle-group.entry';

// =============================================================================
// GROUPS
// =============================================================================

/** The gallery's list groups, in display order (matches the style guide). */
export const GALLERY_GROUPS: Array<{ id: GalleryGroup; label: string }> = [
	{ id: 'chrome', label: 'Host chrome' },
	{ id: 'sidebar', label: 'Sidebar content' },
	{ id: 'content', label: 'Content components' },
];

// =============================================================================
// ENTRIES
// =============================================================================

/** Every gallery entry, in stock-table order within its group. */
export const GALLERY_ENTRIES: IGalleryEntry[] = [
	// Host chrome - always present, never drawn by apps
	docTabsEntry,
	overlaySystemEntry,
	sidebarFrameEntry,
	statusBarEntry,
	// Sidebar content - app mounts these inside the frame's scrolling slot
	explorerEntry,
	sidebarMenuEntry,
	// Content components - app composes freely between DocTabs and StatusBar
	bannerEntry,
	buttonEntry,
	cardEntry,
	chatViewEntry,
	chipEntry,
	connectionCardEntry,
	contentHeaderEntry,
	dataGridEntry,
	detailPanelEntry,
	dropZoneEntry,
	emptyStateEntry,
	inputFieldEntry,
	miniCardEntry,
	sectionEntry,
	statusBadgeEntry,
	tabControlEntry,
	toggleGroupEntry,
];
