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
 * The ordered gallery registry: group declarations plus every entry. The
 * gallery documents the ENTIRE public shell API surface (shell/src/api.ts):
 * host chrome, sidebar content, the document system, content components
 * (alphabetical), platform hooks/context, and the utility layer. Adding a
 * surface symbol to the gallery = writing its entry file under `entries/`
 * and appending it here (plus an ENTRY_SOURCES line in
 * scripts/generate-gallery-tokens.mjs for live-demo entries).
 */

import type { GalleryGroup, IGalleryEntry } from './galleryTypes';

// --- Host chrome -------------------------------------------------------------
import { shellFrameEntry } from './entries/shell-frame.entry';
import { sidebarFrameEntry } from './entries/sidebar-frame.entry';
import { overlaySystemEntry } from './entries/overlay-system.entry';
import { statusBarEntry } from './entries/status-bar.entry';
import { bottomPanelEntry } from './entries/bottom-panel.entry';
import { debugPanelEntry } from './entries/debug-panel.entry';

// --- Sidebar content ---------------------------------------------------------
import { explorerEntry } from './entries/explorer.entry';
import { sidebarMenuEntry } from './entries/sidebar-menu.entry';
import { navButtonEntry } from './entries/nav-button.entry';
import { sidebarFooterEntry } from './entries/sidebar-footer.entry';

// --- Document system ---------------------------------------------------------
import { documentsModelEntry } from './entries/documents-model.entry';
import { docTabsEntry } from './entries/doc-tabs.entry';
import { docSplitLayoutEntry } from './entries/doc-split-layout.entry';
import { docExplorerEntry } from './entries/doc-explorer.entry';

// --- Content components ------------------------------------------------------
import { bannerEntry } from './entries/banner.entry';
import { buttonEntry } from './entries/button.entry';
import { cardEntry } from './entries/card.entry';
import { chatViewEntry } from './entries/chat-view.entry';
import { chipEntry } from './entries/chip.entry';
import { confirmDialogEntry } from './entries/confirm-dialog.entry';
import { connectionCardEntry } from './entries/connection-card.entry';
import { contentHeaderEntry } from './entries/content-header.entry';
import { dataGridEntry } from './entries/data-grid.entry';
import { gridHelpersEntry } from './entries/grid-helpers.entry';
import { detailPanelEntry } from './entries/detail-panel.entry';
import { dropZoneEntry } from './entries/drop-zone.entry';
import { emptyStateEntry } from './entries/empty-state.entry';
import { filterStripEntry } from './entries/filter-strip.entry';
import { inputFieldEntry } from './entries/input-field.entry';
import { miniCardEntry } from './entries/mini-card.entry';
import { modalEntry } from './entries/modal.entry';
import { popupRowEntry } from './entries/popup-row.entry';
import { rocketRideMarkEntry } from './entries/rocketride-mark.entry';
import { sectionEntry } from './entries/section.entry';
import { statusBadgeEntry } from './entries/status-badge.entry';
import { tabControlEntry } from './entries/tab-control.entry';
import { toggleGroupEntry } from './entries/toggle-group.entry';

// --- Hooks & context ---------------------------------------------------------
import { connectionClientEntry } from './entries/connection-client.entry';
import { shellEventsEntry } from './entries/shell-events.entry';
import { authIdentityEntry } from './entries/auth-identity.entry';
import { workspacePrefsEntry } from './entries/workspace-prefs.entry';
import { dataPollingEntry } from './entries/data-polling.entry';
import { uiHooksEntry } from './entries/ui-hooks.entry';
import { iframeBridgeEntry } from './entries/iframe-bridge.entry';

// --- Utilities ---------------------------------------------------------------
import { formattersEntry } from './entries/formatters.entry';
import { iconsEntry } from './entries/icons.entry';
import { themeStylesEntry } from './entries/theme-styles.entry';

// =============================================================================
// GROUPS
// =============================================================================

/** The gallery's list groups, in display order. */
export const GALLERY_GROUPS: Array<{ id: GalleryGroup; label: string }> = [
	{ id: 'chrome', label: 'Host chrome' },
	{ id: 'sidebar', label: 'Sidebar content' },
	{ id: 'documents', label: 'Document system' },
	{ id: 'content', label: 'Content components' },
	{ id: 'hooks', label: 'Hooks & context' },
	{ id: 'utils', label: 'Utilities' },
];

// =============================================================================
// ENTRIES
// =============================================================================

/** Every gallery entry, ordered within its group. */
export const GALLERY_ENTRIES: IGalleryEntry[] = [
	// Host chrome - the frame overview first, then its zones
	shellFrameEntry,
	sidebarFrameEntry,
	overlaySystemEntry,
	statusBarEntry,
	bottomPanelEntry,
	debugPanelEntry,
	// Sidebar content - app mounts these inside the frame's scrolling slot
	explorerEntry,
	sidebarMenuEntry,
	navButtonEntry,
	sidebarFooterEntry,
	// Document system - the model first, then its renderers
	documentsModelEntry,
	docTabsEntry,
	docSplitLayoutEntry,
	docExplorerEntry,
	// Content components - alphabetical
	bannerEntry,
	buttonEntry,
	cardEntry,
	chatViewEntry,
	chipEntry,
	confirmDialogEntry,
	connectionCardEntry,
	contentHeaderEntry,
	dataGridEntry,
	gridHelpersEntry,
	detailPanelEntry,
	dropZoneEntry,
	emptyStateEntry,
	filterStripEntry,
	inputFieldEntry,
	miniCardEntry,
	modalEntry,
	popupRowEntry,
	rocketRideMarkEntry,
	sectionEntry,
	statusBadgeEntry,
	tabControlEntry,
	toggleGroupEntry,
	// Hooks & context - the platform API
	connectionClientEntry,
	shellEventsEntry,
	authIdentityEntry,
	workspacePrefsEntry,
	dataPollingEntry,
	uiHooksEntry,
	iframeBridgeEntry,
	// Utilities - formatters, icons, theme vocabulary
	formattersEntry,
	iconsEntry,
	themeStylesEntry,
];
