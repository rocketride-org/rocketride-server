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
// HOST CHROME CONTEXT — opt-in sidebar-content registration
// =============================================================================
//
// The shell frame owns one slot that apps may fill at runtime, WITHOUT the app
// having to render into the shell's DOM directly:
//
//   Sidebar content — a ReactNode declared via useSidebarContent(), mounted
//   inside the sidebar's scrolling slot (below the fixed header, above the
//   fixed footer). The slot renders even while the sidebar is collapsed to
//   its icon rail; components inside the node read the collapsed flag via
//   shared-ui's useSidebarCollapsed() and decide their own collapsed form.
//
// The mechanism is OPT-IN. An app that never calls it behaves exactly as
// before: its legacy `components.Sidebar` (if any) still renders in the slot.
// The mechanism the app's `<App />` uses to register lives in a DIFFERENT
// context than the resolved state the shell reads, so that updating the
// rendered content does NOT re-render the registering app (which would
// otherwise recreate an inline node and loop). The app consumes only the
// STABLE registration API; the shell chrome (Sidebar) consumes the resolved
// STATE.
//
// Registration model — "the currently mounted active view wins":
//   Each hook instance owns a stable token. It registers on mount, syncs on
//   change, and unregisters on unmount, clearing the shared slot only if it is
//   still the current owner (token match). For DocTabs apps only the active
//   tab's view is mounted, so the mounted active view naturally owns the slot;
//   switching tabs unmounts the old view (clears) and mounts the new one
//   (registers). Last registration wins, so mount/unmount ordering during a
//   switch is irrelevant.
// =============================================================================

import React, { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** The resolved chrome state the shell reads to place content. */
export interface HostChromeState {
	/** App-declared sidebar content, or null when none is registered. */
	sidebarContent: ReactNode | null;
}

/** The stable registration API apps call. Identity never changes across renders. */
interface HostChromeApi {
	/** Register/replace the sidebar content owned by `token`. */
	registerSidebarContent: (token: object, content: ReactNode | null) => void;
	/** Clear the sidebar content if `token` still owns it. */
	unregisterSidebarContent: (token: object) => void;
}

// =============================================================================
// CONTEXTS
// =============================================================================
//
// Two contexts, deliberately split: apps consume only the stable API context so
// their re-render is never driven by content updates; the shell chrome consumes
// the state context.
// =============================================================================

/** No-op API used when a hook is called outside a provider (standalone/tests). */
const NOOP_API: HostChromeApi = {
	registerSidebarContent: () => {},
	unregisterSidebarContent: () => {},
};

/** Empty state used when the reader is mounted outside a provider. */
const EMPTY_STATE: HostChromeState = { sidebarContent: null };

const HostChromeApiContext = createContext<HostChromeApi>(NOOP_API);
const HostChromeStateContext = createContext<HostChromeState>(EMPTY_STATE);

// =============================================================================
// PROVIDER
// =============================================================================

/** Internal owner-tagged sidebar registration. */
interface SidebarSlot {
	token: object;
	content: ReactNode | null;
}

/**
 * Provides the host-chrome registration API and resolved state to the shell
 * subtree. Mounted once by {@link ShellLayout} so it wraps BOTH the sidebar and
 * the client area (where the active app registers from).
 *
 * @param props.children - The shell layout subtree.
 */
export const HostChromeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
	// --- Owner-tagged slot state -------------------------------------------
	const [sidebarSlot, setSidebarSlot] = useState<SidebarSlot | null>(null);

	// --- Stable registration API (identity fixed for the provider's life) ---
	const api = useMemo<HostChromeApi>(() => ({
		registerSidebarContent: (token, content) => {
			// Replace only when the owner changed or the node identity changed,
			// so a stable node registered repeatedly does not churn the chrome.
			setSidebarSlot((cur) => (cur && cur.token === token && cur.content === content ? cur : { token, content }));
		},
		unregisterSidebarContent: (token) => {
			// Clear only if this token still owns the slot (last-writer-wins).
			setSidebarSlot((cur) => (cur && cur.token === token ? null : cur));
		},
	}), []);

	// --- Resolved state the shell chrome consumes --------------------------
	const state = useMemo<HostChromeState>(() => ({
		sidebarContent: sidebarSlot ? sidebarSlot.content : null,
	}), [sidebarSlot]);

	return (
		<HostChromeApiContext.Provider value={api}>
			<HostChromeStateContext.Provider value={state}>
				{children}
			</HostChromeStateContext.Provider>
		</HostChromeApiContext.Provider>
	);
};

// =============================================================================
// READER HOOK (shell chrome)
// =============================================================================

/**
 * Reads the resolved host-chrome state. Consumed by the shell's Sidebar to
 * place app-declared content. NOT for apps.
 *
 * @returns The current {@link HostChromeState}.
 */
export function useHostChromeState(): HostChromeState {
	return useContext(HostChromeStateContext);
}

// =============================================================================
// REGISTRATION HOOK (apps)
// =============================================================================

/**
 * Declare the shell sidebar content for the calling view.
 *
 * Opt-in: an app that never calls this keeps its legacy `components.Sidebar`
 * behavior. Passing a node mounts it inside the sidebar's scrolling slot; passing
 * `null` (or unmounting) withdraws it. When no app supplies sidebar content and
 * the app has no legacy sidebar, the shell renders no sidebar and the client area
 * spans full width.
 *
 * Collapse contract: the node stays mounted while the sidebar is collapsed to
 * its icon rail. Components inside it read shared-ui's `useSidebarCollapsed()`
 * and choose their collapsed form (SidebarMenu iconifies; free-form content
 * typically returns null).
 *
 * @param content - The sidebar node to mount, or null to declare nothing.
 */
export function useSidebarContent(content: ReactNode | null): void {
	const api = useContext(HostChromeApiContext);
	// Stable per-instance ownership token for last-writer-wins arbitration.
	const tokenRef = useRef<object>({});

	// Clear this instance's registration on unmount only (not on every change),
	// so switching content never flashes an empty slot.
	useLayoutEffect(() => {
		const token = tokenRef.current;
		return () => api.unregisterSidebarContent(token);
	}, [api]);

	// Sync the current content into the slot whenever it changes. The provider
	// dedupes by node identity, so a stable node registers once.
	useLayoutEffect(() => {
		api.registerSidebarContent(tokenRef.current, content ?? null);
	}, [api, content]);
}
