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
// VIEWMENU TYPES — one data shape, two independent components
// =============================================================================
//
// A ViewMenu is a plain data declaration of a view's selectable entries. Two
// stock components consume it, each with its own contract:
//
// - PageViewControl — the tabs-across-the-top strip showing a view's pages.
//   The VIEW ITSELF renders it as the very first element of its own content
//   column (above any ContentHeader — the title lives inside each page, below
//   the strip). There is no publish/host machinery: consistency is enforced
//   the same way as Card/DataGrid — views must use the stock component and
//   never hand-roll tab bars.
//
// - SidebarMenu — a plain, standard vertical menu-list component. Not
//   shell-routed: an app composes zero, one, or several of them inside the
//   sidebar content it registers via useSidebarContent, alongside any other
//   content it likes. It iconifies automatically while the shell sidebar is
//   collapsed (see SidebarCollapsedContext).
// =============================================================================

// =============================================================================
// ENTRY
// =============================================================================

import type { ReactNode } from 'react';

/** One selectable entry in a view's sub-view menu. */
export interface ViewMenuEntry {
	/** Stable identifier for the entry; passed back through `onSelect`. */
	id: string;
	/** Human-readable label shown in both renderers. */
	label: string;
	/** Neutral count badge, e.g. Tokens 48. */
	count?: number;
	/** 'error' renders the count badge in --rr-color-error. */
	severity?: 'error';
	/**
	 * Optional icon shown when a SidebarMenu is collapsed to its icon rail
	 * (design-owner decision: collapsed sidebars show icon-only entries).
	 * Entries without an icon fall back to a first-letter glyph.
	 */
	icon?: ReactNode;
	/**
	 * When true, the entry renders muted and is not selectable — used by
	 * SidebarMenu; ignored by PageViewControl.
	 */
	disabled?: boolean;
	/**
	 * Child entries, making this entry an expandable SECTION in SidebarMenu
	 * (one level deep — children never declare children of their own). A
	 * section row does not navigate: clicking it expands its children and
	 * collapses any other open section (accordion — at most ONE section is
	 * open at a time, decision 2026-07-18). While the sidebar is collapsed
	 * to the icon rail, sections flatten: their children render as icon
	 * squares directly. Ignored by PageViewControl and DetailPanel tabs.
	 */
	children?: ViewMenuEntry[];
}

// =============================================================================
// MENU
// =============================================================================

/** The entry list consumed by PageViewControl and SidebarMenu. */
export interface ViewMenu {
	/** Ordered list of selectable sub-view entries. */
	entries: ViewMenuEntry[];
}
