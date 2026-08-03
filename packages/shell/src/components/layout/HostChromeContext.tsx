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
// HOST CHROME CONTEXT — sidebar/status-bar slot registration (shell-internal)
// =============================================================================
//
// INTERNAL plumbing for <AppLayout> — not part of the app-facing surface.
// Apps declare their layout via AppLayout props; AppLayout registers the
// declared nodes here. The shell frame owns two slots filled this way,
// WITHOUT the app having to render into the shell's DOM directly:
//
//   Sidebar content — a ReactNode declared via useSidebarContent(), mounted
//   inside the sidebar's scrolling slot (below the fixed header, above the
//   fixed footer). The slot renders even while the sidebar is collapsed to
//   its icon rail; components inside the node read the collapsed flag via
//   shared-ui's useSidebarCollapsed() and decide their own collapsed form.
//
//   Status-bar content — a ReactNode declared via useStatusBarContent(),
//   mounted inside the shell StatusBar's app slot (between the connection
//   identity on the left and the shell status message on the right). The
//   bar's PRESENCE is content-driven: a non-null registration shows it
//   (AppLayout registers an empty fragment for a bare `showStatus`),
//   nothing registered means no bar.
//
// The registration API lives in a DIFFERENT context than the resolved state
// the shell reads, so that updating the rendered content does NOT re-render
// the registering component (which would otherwise recreate an inline node
// and loop). AppLayout consumes only the STABLE registration API; the shell
// chrome (Sidebar, StatusBar) consumes the resolved STATE.
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
	/** App-declared status-bar content, or null when none is registered. */
	statusBarContent: ReactNode | null;
}

/** The stable registration API apps call. Identity never changes across renders. */
interface HostChromeApi {
	/** Register/replace the sidebar content owned by `token`. */
	registerSidebarContent: (token: object, content: ReactNode | null) => void;
	/** Clear the sidebar content if `token` still owns it. */
	unregisterSidebarContent: (token: object) => void;
	/** Register/replace the status-bar content owned by `token`. */
	registerStatusBarContent: (token: object, content: ReactNode | null) => void;
	/** Clear the status-bar content if `token` still owns it. */
	unregisterStatusBarContent: (token: object) => void;
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
	registerStatusBarContent: () => {},
	unregisterStatusBarContent: () => {},
};

/** Empty state used when the reader is mounted outside a provider. */
const EMPTY_STATE: HostChromeState = { sidebarContent: null, statusBarContent: null };

const HostChromeApiContext = createContext<HostChromeApi>(NOOP_API);
const HostChromeStateContext = createContext<HostChromeState>(EMPTY_STATE);

// =============================================================================
// PROVIDER
// =============================================================================

/** Internal owner-tagged slot registration (shared by both chrome slots). */
interface ContentSlot {
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
	const [sidebarSlot, setSidebarSlot] = useState<ContentSlot | null>(null);
	const [statusBarSlot, setStatusBarSlot] = useState<ContentSlot | null>(null);

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
		registerStatusBarContent: (token, content) => {
			// Same dedupe rule as the sidebar slot.
			setStatusBarSlot((cur) => (cur && cur.token === token && cur.content === content ? cur : { token, content }));
		},
		unregisterStatusBarContent: (token) => {
			// Same last-writer-wins clearing rule as the sidebar slot.
			setStatusBarSlot((cur) => (cur && cur.token === token ? null : cur));
		},
	}), []);

	// --- Resolved state the shell chrome consumes --------------------------
	const state = useMemo<HostChromeState>(() => ({
		sidebarContent: sidebarSlot ? sidebarSlot.content : null,
		statusBarContent: statusBarSlot ? statusBarSlot.content : null,
	}), [sidebarSlot, statusBarSlot]);

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
 * Register the shell sidebar content (shell-internal — AppLayout's plumbing).
 *
 * Passing a node mounts it inside the sidebar's scrolling slot; passing
 * `null` (or unmounting) withdraws it. When nothing is registered the shell
 * renders no sidebar and the client area spans full width.
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

/**
 * Register the shell status-bar content (shell-internal — AppLayout's
 * plumbing).
 *
 * Mirrors {@link useSidebarContent}: passing a node mounts it in the
 * StatusBar's app slot (between the connection identity and the shell status
 * message); passing `null` (or unmounting) withdraws it. The bar's presence
 * is content-driven: a non-null node (even an empty fragment) shows the bar,
 * nothing registered means no bar.
 *
 * Same ownership model as the sidebar slot: the mounted active view wins.
 *
 * @param content - The status-bar node to mount, or null to declare nothing.
 */
export function useStatusBarContent(content: ReactNode | null): void {
	const api = useContext(HostChromeApiContext);
	// Stable per-instance ownership token for last-writer-wins arbitration.
	const tokenRef = useRef<object>({});

	// Clear this instance's registration on unmount only (not on every change),
	// so switching content never flashes an empty slot.
	useLayoutEffect(() => {
		const token = tokenRef.current;
		return () => api.unregisterStatusBarContent(token);
	}, [api]);

	// Sync the current content into the slot whenever it changes. The provider
	// dedupes by node identity, so a stable node registers once.
	useLayoutEffect(() => {
		api.registerStatusBarContent(tokenRef.current, content ?? null);
	}, [api, content]);
}
