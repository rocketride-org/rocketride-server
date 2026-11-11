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
 * FlowPreferencesContext — owns this DOCUMENT's canvas view state.
 *
 * Manages:
 *   - Navigation mode (pan vs lasso-select)
 *   - Canvas lock (prevents node/edge edits)
 *   - Canvas layout (viewport, snap grid)
 *
 * All of it is PER DOCUMENT, read and written through `useAppState` —
 * locking one pipeline, or switching it to select-drag, must not do the same
 * to every other open pipeline. Genuine preferences (drawer widths, the
 * Cloud-prompt dismissal) go through `usePrefs` instead; see the shell's
 * AppStateContext for why the workspace has two accessors.
 *
 * Changes here are infrequent, so separating this context prevents
 * unnecessary re-renders of the graph when only view state changes. Without
 * a provider the accessor is a no-op: defaults apply and nothing persists.
 */

import { createContext, ReactElement, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { IProjectLayout, ICanvasPreferences } from '../types';
import { useAppState } from 'shell';

// =============================================================================
// Constants
// =============================================================================

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

// =============================================================================
// Context shape
// =============================================================================

export interface IFlowPreferencesContext {
	// --- Navigation mode ---------------------------------------------------

	/** Current canvas interaction mode (pan or lasso-select). */
	navigationMode: NavigationMode;

	/** Sets the canvas interaction mode and persists it to host preferences. */
	setNavigationMode: (mode: NavigationMode) => void;

	// --- Canvas lock -------------------------------------------------------

	/** When true, the canvas was opened in externally-readonly mode (e.g. "Other" task viewer). */
	isReadonly: boolean;

	/** Effective lock: true when either externally readonly OR the user toggled the toolbar lock. */
	isLocked: boolean;

	/** Toggles the user-facing canvas lock on/off. No-op when isReadonly=true. */
	toggleLock: () => void;

	// --- Per-project layout ------------------------------------------------

	/** Current project layout (viewport, snap, panel widths, lock). */
	projectLayout: IProjectLayout;

	/**
	 * Merges a partial patch into the current project layout.
	 * Updates both local state and persisted preferences.
	 */
	updateProjectLayout: (patch: Partial<IProjectLayout>) => void;
}

const FlowPreferencesContext = createContext<IFlowPreferencesContext | null>(null);

// =============================================================================
// Provider props
// =============================================================================

/** The view-state key holding this document's canvas layout. */
const LAYOUT_KEY = 'projectLayout';

export interface IFlowPreferencesProviderProps {
	children: ReactNode;

	/** The current project's ID, used to key per-project layout storage. */
	projectId: string;

	/** When true, the canvas was opened in externally-readonly mode. The toolbar lock button is hidden. */
	isReadonly?: boolean;
}

// =============================================================================
// Provider
// =============================================================================

/**
 * Provides canvas preference state to all descendants.
 *
 * Reads stored preferences on mount and when `projectId` changes.
 * All mutations are immediately reflected in local state and
 * asynchronously persisted via the host callbacks.
 */
export function FlowPreferencesProvider({ children, projectId, isReadonly = false }: IFlowPreferencesProviderProps): ReactElement {
	// --- This document's canvas state (useAppState) -------------------------
	// Lock / nav / layout are PER DOCUMENT, not preferences: locking one
	// pipeline's canvas or switching it to select-drag must not do the same
	// to every other open pipeline. They ride this document's view state,
	// which ProjectView owns and reports upward (see docViewState.tsx).
	const { getAppState, setAppState } = useAppState();

	// --- Per-project layout ------------------------------------------------

	/** Reads the stored layout for the current project, merging with defaults. */
	const readStoredLayout = useCallback((): IProjectLayout => {
		const stored = getAppState(LAYOUT_KEY) as IProjectLayout | null;
		return { ...DEFAULT_PROJECT_LAYOUT, ...(stored ?? {}) };
	}, [projectId, getAppState]);

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

				// A FLAT key: the accessor is already bound to THIS document,
				// so there is nothing to key by project — the per-pipeline
				// separation IS the view-state blob.
				setAppState(LAYOUT_KEY, next);

				return next;
			});
		},
		[projectId, setAppState]
	);

	// --- Navigation mode ---------------------------------------------------

	const [navigationMode, setNavigationModeState] = useState<NavigationMode>(() => {
		const stored = getAppState('navigationMode') as NavigationMode | undefined;
		return stored ?? (DEFAULT_CANVAS_PREFERENCES.navigationMode as NavigationMode) ?? NavigationMode.DRAG;
	});

	const setNavigationMode = useCallback(
		(mode: NavigationMode) => {
			setNavigationModeState(mode);
			setAppState('navigationMode', mode);
		},
		[setAppState]
	);

	// --- Canvas lock -------------------------------------------------------

	const internalIsLocked = projectLayout.isLocked ?? false;
	const isLocked = isReadonly || internalIsLocked;

	const toggleLock = useCallback(() => {
		if (isReadonly) return; // can't unlock when externally readonly
		updateProjectLayout({ isLocked: !internalIsLocked });
	}, [isReadonly, updateProjectLayout, internalIsLocked]);

	// --- Context value -----------------------------------------------------
	// Memoized so consumers (notably Canvas → <ReactFlow>) don't re-render on
	// every provider render. An unmemoized value here made the canvas re-render
	// continuously, feeding React Flow's StoreUpdater and amplifying the
	// measurement feedback loop into "Maximum update depth exceeded".

	const value = useMemo<IFlowPreferencesContext>(
		() => ({
			navigationMode,
			setNavigationMode,
			isReadonly,
			isLocked,
			toggleLock,
			projectLayout,
			updateProjectLayout,
		}),
		[navigationMode, setNavigationMode, isReadonly, isLocked, toggleLock, projectLayout, updateProjectLayout]
	);

	return <FlowPreferencesContext.Provider value={value}>{children}</FlowPreferencesContext.Provider>;
}

// =============================================================================
// Hook
// =============================================================================

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
