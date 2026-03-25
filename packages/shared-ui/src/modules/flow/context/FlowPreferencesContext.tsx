// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * FlowPreferencesContext — Owns per-project layout and global canvas preferences.
 *
 * Manages:
 *   - Navigation mode (pan vs lasso-select)
 *   - Canvas lock (prevents node/edge edits)
 *   - Per-project layout (viewport, snap grid, panel widths)
 *   - Global preference read/write (delegated to host via getPreference/setPreference)
 *
 * Changes to preferences are infrequent, so separating this context prevents
 * unnecessary re-renders of the graph when only preferences change.
 *
 * The host (VS Code extension or standalone app) provides `getPreference` and
 * `setPreference` callbacks. When absent, defaults are used and preferences
 * are not persisted.
 */

import { createContext, ReactElement, ReactNode, useCallback, useContext, useEffect, useState } from 'react';

import { IProjectLayout, ICanvasPreferences } from '../types';

// ============================================================================
// Constants
// ============================================================================

/** Canvas interaction mode controlling how mouse drag behaves. */
export enum NavigationMode {
	/** Drag pans the viewport. */
	DRAG = 'drag',
	/** Drag draws a selection rectangle. */
	SELECT = 'select',
}

/** Default per-project layout when no stored layout exists. */
export const DEFAULT_PROJECT_LAYOUT: IProjectLayout = {
	isLocked: false,
	snapToGrid: true,
	snapGridSize: [10, 10],
};

/** Default global canvas preferences. */
export const DEFAULT_CANVAS_PREFERENCES: ICanvasPreferences = {
	navigationMode: NavigationMode.DRAG,
};

// ============================================================================
// Context shape
// ============================================================================

export interface IFlowPreferencesContext {
	// --- Navigation mode ---------------------------------------------------

	/** Current canvas interaction mode (pan or lasso-select). */
	navigationMode: NavigationMode;

	/** Sets the canvas interaction mode and persists it to host preferences. */
	setNavigationMode: (mode: NavigationMode) => void;

	// --- Canvas lock -------------------------------------------------------

	/** When true, nodes and edges cannot be moved, connected, or deleted. */
	isLocked: boolean;

	/** Toggles the canvas lock on/off and persists the change. */
	toggleLock: () => void;

	// --- Per-project layout ------------------------------------------------

	/** Current project layout (viewport, snap, panel widths, lock). */
	projectLayout: IProjectLayout;

	/**
	 * Merges a partial patch into the current project layout.
	 * Updates both local state and persisted preferences.
	 */
	updateProjectLayout: (patch: Partial<IProjectLayout>) => void;

	// --- Raw preference access (pass-through to host) ----------------------

	/** Reads a preference value by key. Returns undefined when host doesn't provide storage. */
	getPreference: (key: string) => unknown;

	/** Writes a preference value by key. No-op when host doesn't provide storage. */
	setPreference: (key: string, value: unknown) => void;
}

const FlowPreferencesContext = createContext<IFlowPreferencesContext | null>(null);

// ============================================================================
// Provider props
// ============================================================================

export interface IFlowPreferencesProviderProps {
	children: ReactNode;

	/** The current project's ID, used to key per-project layout storage. */
	projectId: string;

	/** Host-provided preference reader. When absent, defaults are used. */
	getPreference?: (key: string) => unknown;

	/** Host-provided preference writer. When absent, preferences are not persisted. */
	setPreference?: (key: string, value: unknown) => void;
}

// ============================================================================
// Provider
// ============================================================================

/**
 * Provides canvas preference state to all descendants.
 *
 * Reads stored preferences on mount and when `projectId` changes.
 * All mutations are immediately reflected in local state and
 * asynchronously persisted via the host callbacks.
 */
export function FlowPreferencesProvider({ children, projectId, getPreference: hostGetPreference, setPreference: hostSetPreference }: IFlowPreferencesProviderProps): ReactElement {
	// --- Preference helpers (safe even when host callbacks are absent) ------

	const getPreference = useCallback((key: string): unknown => hostGetPreference?.(key), [hostGetPreference]);

	const setPreference = useCallback((key: string, value: unknown): void => hostSetPreference?.(key, value), [hostSetPreference]);

	// --- Per-project layout ------------------------------------------------

	/** Reads the stored layout for the current project, merging with defaults. */
	const readStoredLayout = useCallback((): IProjectLayout => {
		const layouts = getPreference('projectLayouts') as Record<string, IProjectLayout> | null;
		return { ...DEFAULT_PROJECT_LAYOUT, ...(layouts?.[projectId] ?? {}) };
	}, [projectId, getPreference]);

	const [projectLayout, setProjectLayout] = useState<IProjectLayout>(readStoredLayout);

	// Re-read when projectId or preference source changes
	useEffect(() => {
		setProjectLayout(readStoredLayout());
	}, [readStoredLayout]);

	/** Merges a patch into both local state and persisted preferences. */
	const updateProjectLayout = useCallback(
		(patch: Partial<IProjectLayout>) => {
			setProjectLayout((prev) => {
				const next = { ...prev, ...patch };

				// Persist the full layout map back to host preferences
				if (hostSetPreference && projectId) {
					const layouts = (getPreference('projectLayouts') as Record<string, IProjectLayout> | null) ?? {};
					hostSetPreference('projectLayouts', {
						...layouts,
						[projectId]: next,
					});
				}

				return next;
			});
		},
		[projectId, getPreference, hostSetPreference]
	);

	// --- Navigation mode ---------------------------------------------------

	const [navigationMode, setNavigationModeState] = useState<NavigationMode>(() => {
		const stored = getPreference('navigationMode') as NavigationMode | undefined;
		return stored ?? (DEFAULT_CANVAS_PREFERENCES.navigationMode as NavigationMode) ?? NavigationMode.DRAG;
	});

	const setNavigationMode = useCallback(
		(mode: NavigationMode) => {
			setNavigationModeState(mode);
			setPreference('navigationMode', mode);
		},
		[setPreference]
	);

	// --- Canvas lock -------------------------------------------------------

	const [isLocked, setIsLocked] = useState<boolean>(() => projectLayout.isLocked ?? DEFAULT_PROJECT_LAYOUT.isLocked ?? false);

	const toggleLock = useCallback(() => {
		setIsLocked((prev) => {
			const next = !prev;
			updateProjectLayout({ isLocked: next });
			return next;
		});
	}, [updateProjectLayout]);

	// --- Context value (stable references via useCallback) -----------------

	const value: IFlowPreferencesContext = {
		navigationMode,
		setNavigationMode,
		isLocked,
		toggleLock,
		projectLayout,
		updateProjectLayout,
		getPreference,
		setPreference,
	};

	return <FlowPreferencesContext.Provider value={value}>{children}</FlowPreferencesContext.Provider>;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Returns the flow preferences context.
 *
 * @throws When called outside of a FlowPreferencesProvider.
 */
export function useFlowPreferences(): IFlowPreferencesContext {
	const ctx = useContext(FlowPreferencesContext);
	if (!ctx) {
		throw new Error('useFlowPreferences must be used within a FlowPreferencesProvider');
	}
	return ctx;
}
