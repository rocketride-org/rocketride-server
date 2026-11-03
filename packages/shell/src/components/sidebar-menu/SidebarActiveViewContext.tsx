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
// SIDEBAR ACTIVE VIEW CONTEXT — the workbench rail's channel to shared content
// =============================================================================
//
// When the shell renders a 'vscode'/'cursor' sidebar, the rail (or tab strip)
// owns WHICH view container is active. Containers that bring their own
// `content` node are switched by the shell directly; containers that share
// the app's single registered `sidebar` node instead learn the selection
// through THIS context — the shared node reads `useSidebarActiveView()` and
// presents the matching view, keeping one data owner behind N rail icons.
//
// Null only outside every view-driven frame: the classic 'rocketride'
// column mounts no provider, so content running there falls back to its own
// internal switching — the exact behavior it had before modes existed. The
// compact DRAWER of an app with declared views DOES mount the provider
// (its strip owns the selection exactly like the workbench rail), so shared
// content must not assume the drawer always yields null.
// =============================================================================

import React, { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** The workbench's view selection, as shared sidebar content sees it. */
export interface SidebarActiveView {
	/** The active view container's id. */
	activeViewId: string;
	/** Ask the workbench to activate another container (also opens the panel). */
	setActiveView: (id: string) => void;
}

// =============================================================================
// CONTEXT
// =============================================================================

/** Null = no workbench chrome around this content (classic frame / drawer). */
const SidebarActiveViewContext = createContext<SidebarActiveView | null>(null);

// =============================================================================
// PROVIDER
// =============================================================================

/** Props for the {@link SidebarActiveViewProvider} component. */
export interface ISidebarActiveViewProviderProps {
	/** The workbench's current selection and setter. */
	value: SidebarActiveView;
	/** The sidebar-slot subtree that may read the selection. */
	children: ReactNode;
}

/**
 * Provides the workbench's active-view selection to shared sidebar content.
 * Mounted by the shell's workbench frame around the panel's content slot.
 *
 * @param props - {@link ISidebarActiveViewProviderProps}.
 * @returns The provider element.
 */
export const SidebarActiveViewProvider: React.FC<ISidebarActiveViewProviderProps> = ({ value, children }) => (
	<SidebarActiveViewContext.Provider value={value}>{children}</SidebarActiveViewContext.Provider>
);

// =============================================================================
// HOOK
// =============================================================================

/**
 * Reads the active-view selection, or null when no view-driven chrome
 * encloses this content (the classic sidebar column, tests). The compact
 * drawer of an app WITH declared views provides a selection too — only the
 * classic column yields null. Shared sidebar content uses the null case to
 * keep its own switcher.
 *
 * @returns The selection handle, or null under the classic chrome.
 */
export function useSidebarActiveView(): SidebarActiveView | null {
	return useContext(SidebarActiveViewContext);
}
