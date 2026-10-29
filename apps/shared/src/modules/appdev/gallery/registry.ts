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
import { checkboxEntry } from './entries/checkbox.entry';
import { comboboxEntry } from './entries/combobox.entry';
import { fieldEntry } from './entries/field.entry';
import { iconButtonEntry } from './entries/icon-button.entry';
import { menuEntry } from './entries/menu.entry';
import { popoverEntry } from './entries/popover.entry';
import { radioGroupEntry } from './entries/radio-group.entry';
import { selectEntry } from './entries/select.entry';
import { sliderEntry } from './entries/slider.entry';
import { textAreaEntry } from './entries/text-area.entry';
import { toastEntry } from './entries/toast.entry';
import { tooltipEntry } from './entries/tooltip.entry';
import { accordionEntry } from './entries/accordion.entry';
import { avatarEntry } from './entries/avatar.entry';
import { badgeEntry } from './entries/badge.entry';
import { breadcrumbsEntry } from './entries/breadcrumbs.entry';
import { dividerEntry } from './entries/divider.entry';
import { listEntry } from './entries/list.entry';
import { paginationEntry } from './entries/pagination.entry';
import { progressEntry } from './entries/progress.entry';
import { skeletonEntry } from './entries/skeleton.entry';
import { stepperEntry } from './entries/stepper.entry';
import { tableEntry } from './entries/table.entry';
import { treeEntry } from './entries/tree.entry';

import { pageLayoutEntry } from './entries/page-layout.entry';
import { settingsSectionEntry } from './entries/settings-section.entry';
import { themeSwitcherEntry } from './entries/theme-switcher.entry';
import { statusPageEntry } from './entries/status-page.entry';

import { dashboardGridEntry } from './entries/dashboard-grid.entry';
import { statCardEntry } from './entries/stat-card.entry';
import { chartCardEntry } from './entries/chart-card.entry';
import { lineChartEntry } from './entries/line-chart.entry';
import { barChartEntry } from './entries/bar-chart.entry';
import { sparklineEntry } from './entries/sparkline.entry';
import { meterEntry } from './entries/meter.entry';
import { activityFeedEntry } from './entries/activity-feed.entry';

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
	{ id: 'layouts', label: 'Page layouts' },
	{ id: 'dashboards', label: 'Dashboard widgets' },
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
	// Page layouts - the page scaffold first, then its building blocks
	pageLayoutEntry,
	settingsSectionEntry,
	themeSwitcherEntry,
	statusPageEntry,
	// Dashboard widgets - the grid first, then tiles, chart panel, charts, feed
	dashboardGridEntry,
	statCardEntry,
	chartCardEntry,
	lineChartEntry,
	barChartEntry,
	sparklineEntry,
	meterEntry,
	activityFeedEntry,
	// Content components - alphabetical
	accordionEntry,
	avatarEntry,
	badgeEntry,
	bannerEntry,
	breadcrumbsEntry,
	buttonEntry,
	cardEntry,
	chatViewEntry,
	checkboxEntry,
	chipEntry,
	comboboxEntry,
	confirmDialogEntry,
	connectionCardEntry,
	contentHeaderEntry,
	dataGridEntry,
	gridHelpersEntry,
	detailPanelEntry,
	dividerEntry,
	dropZoneEntry,
	emptyStateEntry,
	fieldEntry,
	filterStripEntry,
	iconButtonEntry,
	inputFieldEntry,
	listEntry,
	menuEntry,
	miniCardEntry,
	modalEntry,
	paginationEntry,
	popoverEntry,
	popupRowEntry,
	progressEntry,
	radioGroupEntry,
	rocketRideMarkEntry,
	sectionEntry,
	selectEntry,
	skeletonEntry,
	sliderEntry,
	statusBadgeEntry,
	stepperEntry,
	tabControlEntry,
	tableEntry,
	textAreaEntry,
	toastEntry,
	toggleGroupEntry,
	tooltipEntry,
	treeEntry,
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
