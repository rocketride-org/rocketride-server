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
// VIEWS FROM MENU — opt-in projection of a ViewMenu onto the activity rail
// =============================================================================

/**
 * `viewsFromMenu` promotes a menu-shaped sidebar onto the activity rail: each
 * top-level SECTION (an entry with children) becomes one rail view container,
 * so section switching moves to the rail while the section's children render
 * as the panel body.
 *
 * STRICTLY OPT-IN — the shell never applies this transform itself. A
 * `ViewMenu`'s sections may be true modes (good rail candidates) or mere
 * visual grouping inside one navigation flow; only the app's author knows,
 * and auto-promoting would silently change the information architecture of
 * shipped apps. An app opts in by passing the result as `sidebarViews` on
 * its AppLayout, keeping its existing menu data as the single source:
 *
 *   <AppLayout
 *       sidebar={<MySidebar />}                 // still the panel content
 *       sidebarViews={viewsFromMenu(MY_MENU)}   // sections -> rail icons
 *   >
 *
 * The produced containers are CONTENT-LESS: they all share the app's
 * registered sidebar node, which reads `useSidebarActiveView()` and renders
 * only the active section's children. Selection state stays in the app.
 */

import React from 'react';
import type { ViewMenu, ViewMenuEntry } from '../../types/viewMenu';
import type { SidebarViewContainer } from '../../types/sidebarChrome';

// =============================================================================
// OPTIONS
// =============================================================================

/** Options for {@link viewsFromMenu}. */
export interface ViewsFromMenuOptions {
	/**
	 * What becomes of top-level entries WITHOUT children (e.g. a Dashboard
	 * row above the sections):
	 *   'own-view' (default) — each loose entry becomes its own rail view,
	 *                          in declaration order alongside the sections.
	 *   'ignore'             — loose entries are dropped from the rail; the
	 *                          app keeps rendering them inside the panel.
	 */
	looseEntries?: 'own-view' | 'ignore';
	/** Id of the container the panel opens on by default (isDefault). */
	defaultId?: string;
}

// =============================================================================
// ADAPTER
// =============================================================================

/** First-letter glyph for entries that declare no icon (the rail needs one). */
function letterGlyph(label: string): React.ReactNode {
	return (
		<span aria-hidden style={{ fontSize: 14, fontWeight: 700, lineHeight: 1 }}>
			{(label.trim()[0] ?? '?').toUpperCase()}
		</span>
	);
}

/**
 * Projects a ViewMenu's top level onto rail view containers (see the module
 * doc for the contract and the opt-in rule).
 *
 * @param menu - The app's existing menu — unchanged, still the one source.
 * @param options - See {@link ViewsFromMenuOptions}.
 * @returns Containers for `sidebarViews`, in declaration order.
 */
export function viewsFromMenu(menu: ViewMenu, options: ViewsFromMenuOptions = {}): SidebarViewContainer[] {
	const loose = options.looseEntries ?? 'own-view';
	const out: SidebarViewContainer[] = [];
	for (const entry of menu.entries) {
		const isSection = (entry.children?.length ?? 0) > 0;
		if (!isSection && loose === 'ignore') continue;
		if (entry.disabled) continue;
		out.push({
			id: entry.id,
			title: entry.label,
			icon: entry.icon ?? letterGlyph(entry.label),
			badge: entry.count,
			isDefault: options.defaultId === entry.id || undefined,
		});
	}
	return out;
}

/**
 * The active section's child entries, for panel bodies that render "the
 * current section's menu" — the usual companion to {@link viewsFromMenu}.
 *
 * @param menu - The same menu passed to viewsFromMenu.
 * @param activeViewId - The rail selection (from `useSidebarActiveView`).
 * @returns The active section's children ([] for loose entries — they ARE
 *          the destination, nothing nests beneath them).
 */
export function menuSectionEntries(menu: ViewMenu, activeViewId: string): ViewMenuEntry[] {
	return menu.entries.find((e) => e.id === activeViewId)?.children ?? [];
}
