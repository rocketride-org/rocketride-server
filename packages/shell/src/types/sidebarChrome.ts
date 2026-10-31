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
// SIDEBAR CHROME — the app-facing declaration types for sidebar modes
// =============================================================================
//
// The DATA is the contract; the mode is a projection of it. An app that
// declares only the legacy `sidebar` ReactNode supports 'rocketride' (the
// classic single column that iconifies when collapsed). An app that also
// declares `sidebarViews` unlocks the richer chromes:
//
//   'rocketride'  the classic column — views (if any) are ignored by the
//                 frame; the registered content node renders as always.
//   'vscode'      a fixed activity rail (one icon per view container) beside
//                 a resizable panel; clicking the active icon toggles the
//                 panel; the panel never iconifies.
//   'cursor'      the same panel with the container switcher as a horizontal
//                 tab strip across the panel top instead of a vertical rail.
//
// The shell clamps the requested mode to what the declared data supports:
// 'vscode'/'cursor' without a non-empty `sidebarViews` falls back to
// 'rocketride'. Below the compact breakpoint every mode renders the same
// drawer — a rail-plus-drawer makes no sense on a phone.
// =============================================================================

import type { ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** The sidebar chrome an app asks the shell frame to render. */
export type ShellSidebarMode = 'rocketride' | 'vscode' | 'cursor';

/**
 * One sidebar view container — an icon on the activity rail ('vscode') or an
 * entry in the panel's tab strip ('cursor'), selecting what the panel shows.
 *
 * `content` is OPTIONAL: a container without its own node shares the app's
 * registered `sidebar` content, and the shell announces the active container
 * through the active-view context (`useSidebarActiveView`) so that shared
 * node can switch what it presents. This is the one-data-instance path — an
 * app whose sidebar already multiplexes modes internally (a tab strip over
 * one state owner) adopts the rail without duplicating its data wiring.
 */
export interface SidebarViewContainer {
	/** Stable id — the active-view selection and persistence key. */
	id: string;
	/** Rail tooltip ('vscode') / tab label ('cursor') / panel header label. */
	title: string;
	/** The rail / tab glyph. Sized by the caller (20px reads well on the rail). */
	icon: ReactNode;
	/** Panel body when this container is active. Omitted = the shared
	    `sidebar` node serves this container (see the interface doc). */
	content?: ReactNode;
	/** Optional rail/tab badge (a count or a short marker). */
	badge?: number | string;
	/** Rail/tab position; declaration order where omitted. */
	order?: number;
	/** The container the panel opens on when the user has no stored choice.
	    Rail POSITION and startup DEFAULT are independent (VS Code opens on
	    Explorer; this platform opens on Agent). First container when unset. */
	isDefault?: boolean;
}
