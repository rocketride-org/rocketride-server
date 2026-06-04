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
// WORKSPACE CONTEXT — state management + event bus
// =============================================================================

import React, { createContext, useContext, useCallback, useRef, useState, useEffect } from 'react';
import { RocketRideClient } from 'rocketride';
import { useWorkspaceState } from './useWorkspaceState';
import type { WorkspacePrefs, AppDescriptor, AppManifestEntry } from './types';
import type { ShellConnectionEventMap } from 'shared';
import { ConnectionManager } from '../connection/connection';

// =============================================================================
// SESSION PERSISTENCE HELPER
// =============================================================================

/**
 * Saves the active app ID to sessionStorage so a browser refresh can restore
 * the user's last position.  Cleared when returning to 'home' so that a fresh
 * load without a session lock always lands on the home screen.
 *
 * @param appId - The app being switched to.
 */
function persistActiveApp(appId: string): void {
	try {
		if (appId === 'rocketride.home') {
			sessionStorage.removeItem('rr:appId');
		} else {
			sessionStorage.setItem('rr:appId', appId);
		}
	} catch { /* storage unavailable */ }
}

/**
 * Flag to suppress pushState inside a popstate handler.
 * When the browser back/forward button fires popstate, we switch the app
 * but must NOT push a new history entry (that would break the stack).
 */
let _suppressPush = false;

/**
 * Pushes a browser history entry for the given app so that the
 * back/forward buttons navigate between apps.
 *
 * @param appId - The app being navigated to.
 */
function pushAppHistory(appId: string): void {
	if (_suppressPush) return;
	try {
		window.history.pushState({ appId }, '', window.location.pathname + window.location.search);
	} catch { /* sandboxed iframe or similar */ }
}

// =============================================================================
// CONTEXT SHAPE
// =============================================================================

/**
 * The full public API surface of the workspace context — consumed by any
 * component or hook that calls `useWorkspace()`.
 */
export interface IWorkspaceContext {
	/** True once the initial workspace load from disk has completed. */
	loaded: boolean;
	/** True once pre-auth default state has been seeded (before disk load). */
	seeded: boolean;
	/** True while the active app's descriptor is being dynamically loaded. */
	appLoading: boolean;
	/** The active app's preferences. */
	prefs: WorkspacePrefs;
	/** Opaque app-owned state (used by Documents library). */
	appState: Record<string, unknown>;
	/** Update the opaque app-owned state via a functional updater. */
	updateAppState: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void;
	/** ID of the currently active app. */
	activeAppId: string;
	/** Lightweight manifest entries for all apps — always available, no bundle load needed. */
	appManifest: AppManifestEntry[];
	/** Fully loaded AppDescriptors, keyed by appId — populated lazily on first activation. */
	loadedApps: Record<string, AppDescriptor>;
	/** Triggers a lazy load of an app's descriptor if not already loaded. */
	loadApp: (appId: string) => void;
	/** Per-app descriptor load-failure messages, keyed by appId. Absent ⇒ no error. */
	appLoadErrors: Record<string, string>;
	/** Clears the recorded load error for an app and re-attempts its descriptor load. */
	retryApp: (appId: string) => void;
	/** Persisted settings — keyed by setting key (e.g. 'ROCKETRIDE_OPENAI_KEY'). */
	settings: Record<string, string>;
	/** Persist a single setting value. */
	updateSetting: (key: string, value: string) => void;
	/** Update the active app's workspace preferences. */
	updatePrefs: (patch: Partial<WorkspacePrefs>) => void;
	/** Available theme options (id + display name). */
	themeOptions: { id: string; name: string }[];
	/** Switch the active theme (updates prefs and applies CSS). */
	setTheme: (themeId: string) => void;
	/** @deprecated Use `updatePrefs` for prefs, `ConnectionManager.getInstance().emit('shell:switchApp')` for app switches. */
	dispatch: (action: { type: string; [key: string]: unknown }) => void;
	/** Emit a named event to all subscribers. Does NOT mutate workspace state. */
	emit: <K extends keyof ShellConnectionEventMap>(event: K, payload: ShellConnectionEventMap[K]) => void;
	/** Subscribe to a named event. Returns an unsubscribe function. */
	on: <K extends keyof ShellConnectionEventMap>(event: K, handler: (payload: ShellConnectionEventMap[K]) => void) => () => void;
}

// =============================================================================
// CONTEXT
// =============================================================================

/**
 * React context that holds the workspace state and event bus.
 * Initialised to `null`; `useWorkspace()` asserts non-null at call sites.
 */
const WorkspaceContext = createContext<IWorkspaceContext | null>(null);

// =============================================================================
// PROVIDER
// =============================================================================

/**
 * Provides workspace state, lazy app descriptor loading, and the shell event
 * bus to the entire React tree beneath it.
 *
 * @param client        - The live RocketRideClient (or null while connecting).
 * @param isConnected   - Whether the RocketRide WebSocket is currently open.
 * @param apps          - Array of lightweight app manifest entries.
 * @param workspaceDir  - Directory for workspace persistence files (default ".workspace").
 * @param startupAppId  - Optional app to activate on initial load (overrides saved state).
 * @param children      - React subtree that will receive the context.
 */
export const WorkspaceProvider: React.FC<{
	client: RocketRideClient | null;
	isConnected: boolean;
	apps: AppManifestEntry[];
	workspaceDir?: string;
	startupAppId?: string;
	children: React.ReactNode;
	defaultAppId?: string;
	themeOptions?: { id: string; name: string }[];
	onThemeChange?: (themeId: string) => void;
}> = ({ client, isConnected, apps, workspaceDir, startupAppId, defaultAppId: defaultAppIdProp, themeOptions: themeOptionsProp, onThemeChange, children }) => {
	// Default app ID — use the prop from Shell (mode-aware), or fall back to hello.
	const defaultAppId = defaultAppIdProp || 'rocketride.hello';

	// Destructure all state and mutation helpers from the persistence hook
	const {
		loaded, seeded, activeAppId, prefs, appState, settings,
		switchApp, updatePrefs, updateAppState, updateSetting,
	} = useWorkspaceState(client, isConnected, defaultAppId, workspaceDir, startupAppId);

	// --- Lazy descriptor loading -----------------------------------------------

	// Map of fully loaded AppDescriptors, keyed by appId
	const [loadedApps, setLoadedApps] = useState<Record<string, AppDescriptor>>({});
	// True while any app descriptor dynamic import is in flight
	const [appLoading, setAppLoading] = useState(false);
	// Ref mirror of loadedApps so loadDescriptor's closure never stales
	const loadedAppsRef = useRef<Record<string, AppDescriptor>>({});
	// Tracks which appIds currently have an in-flight load
	const loadingSetRef = useRef<Set<string>>(new Set());
	// Tracks appIds whose load has FAILED so the auto-load effect won't silently
	// re-attempt them (only retryApp clears this). Directly mutated, like loadingSetRef.
	const failedSetRef = useRef<Set<string>>(new Set());
	// Per-app descriptor load-failure messages, keyed by appId (surfaced to the UI
	// so a failed remote shows an error + Retry instead of an indefinite "Loading…")
	const [appLoadErrors, setAppLoadErrors] = useState<Record<string, string>>({});

	// Keep the ref mirror up to date
	useEffect(() => { loadedAppsRef.current = loadedApps; }, [loadedApps]);

	/**
	 * Dynamically imports the AppDescriptor for the given appId.
	 *
	 * Guards against duplicate loads and concurrent loads.  Sets `appLoading`
	 * to true for the duration and clears it once all in-flight loads complete.
	 *
	 * @param appId - The app whose descriptor should be loaded.
	 */
	const loadDescriptor = useCallback(async (appId: string) => {
		// Skip if already loaded
		if (loadedAppsRef.current[appId]) { return; }
		// Skip if a load is already in flight
		if (loadingSetRef.current.has(appId)) { return; }
		// Skip if this app already failed — only retryApp re-attempts it (it clears
		// failedSetRef first), so the auto-load effect can't silently re-arm the load.
		if (failedSetRef.current.has(appId)) { return; }
		// Find the manifest entry
		const entry = apps.find((a) => a.id === appId);
		if (!entry) return;

		// Mark as in-flight and raise loading flag
		loadingSetRef.current.add(appId);
		setAppLoading(true);
		// A fresh (re)attempt clears any stale error recorded for this app
		setAppLoadErrors((prev) => { if (!prev[appId]) return prev; const next = { ...prev }; delete next[appId]; return next; });
		try {
			// Load with timeout to avoid indefinite hangs on unreachable remotes
			const APP_LOAD_TIMEOUT = 15000;
			const descriptor = await Promise.race([
				entry.load(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error(`App "${appId}" failed to load within ${APP_LOAD_TIMEOUT / 1000}s`)), APP_LOAD_TIMEOUT),
				),
			]);

			// Validate the descriptor has the minimum required shape
			if (!descriptor || !descriptor.components?.App) {
				console.error(`[WorkspaceContext] Invalid AppDescriptor for "${appId}": missing components.App`);
				failedSetRef.current.add(appId);
				setAppLoadErrors((prev) => ({ ...prev, [appId]: `App "${appId}" loaded but is missing its UI (components.App) — the bundle may be stale or only partially deployed.` }));
				return;
			}

			setLoadedApps((prev) => ({ ...prev, [appId]: descriptor }));
		} catch (e) {
			console.error(`[WorkspaceContext] Failed to load AppDescriptor for "${appId}":`, e);
			failedSetRef.current.add(appId);
			setAppLoadErrors((prev) => ({ ...prev, [appId]: (e instanceof Error ? e.message : String(e)) || `App "${appId}" failed to load.` }));
		} finally {
			loadingSetRef.current.delete(appId);
			if (loadingSetRef.current.size === 0) setAppLoading(false);
		}
	}, [apps]);

	/**
	 * Re-attempts an app's descriptor load after a failure. Clears the failure
	 * marker synchronously (failedSetRef is what stops the auto-load effect from
	 * silently re-trying a down app, so an explicit retry must clear it first);
	 * loadDescriptor itself clears the displayed error when the attempt starts.
	 */
	const retryApp = useCallback((appId: string) => {
		failedSetRef.current.delete(appId);
		loadDescriptor(appId);
	}, [loadDescriptor]);

	// Load the active app's descriptor once workspace state is ready
	// (seeded is enough — don't wait for the full disk load)
	useEffect(() => {
		if (loaded || seeded) loadDescriptor(activeAppId);
	}, [loaded, seeded, activeAppId, loadDescriptor]);

	// --- shell:switchApp → programmatic app switch ----------------------------

	useEffect(() => {
		/** Allows non-React code to switch the active app without having
		 *  access to WorkspaceContext dispatch. */
		return ConnectionManager.getInstance().on('shell:switchApp', ({ appId }) => {
			// Resolve $HOME to the platform default, and unknown appIds to the default
			const target = appId === '$HOME' ? defaultAppId : appId;
			const resolved = apps.find((a) => a.id === target) ? target : defaultAppId;
			switchApp(resolved);
			loadDescriptor(resolved);
			persistActiveApp(resolved);
			pushAppHistory(resolved);
		});
	}, [switchApp, loadDescriptor, apps, defaultAppId]);

	// --- popstate → browser back/forward restores previous app -------------------

	useEffect(() => {
		/** Replace the current history entry with the initial app so back works
		 *  correctly from the very first app switch. */
		try {
			window.history.replaceState({ appId: activeAppId }, '', window.location.pathname + window.location.search);
		} catch { /* ignore */ }

		/** Handle browser back/forward by switching to the app stored in state. */
		const onPopState = (e: PopStateEvent) => {
			const appId = e.state?.appId as string | undefined;
			if (!appId) return;

			// Suppress pushState — we're restoring, not navigating forward
			_suppressPush = true;
			switchApp(appId);
			loadDescriptor(appId);
			persistActiveApp(appId);
			_suppressPush = false;
		};

		window.addEventListener('popstate', onPopState);
		return () => window.removeEventListener('popstate', onPopState);
	}, [switchApp, loadDescriptor]);

	// --- Event bus — delegates to connectionManager singleton -------------------------

	/**
	 * Emits a typed shell event by delegating to the connectionManager singleton.
	 * Stable reference — safe to pass as a prop or store in a ref.
	 */
	const emit = useCallback(<K extends keyof ShellConnectionEventMap>(event: K, payload: ShellConnectionEventMap[K]) => {
		ConnectionManager.getInstance().emit(event, payload);
	}, []);

	/**
	 * Subscribes to a typed shell event by delegating to the connectionManager singleton.
	 * Returns an unsubscribe function.  Stable reference.
	 */
	const on = useCallback(<K extends keyof ShellConnectionEventMap>(event: K, handler: (payload: ShellConnectionEventMap[K]) => void): () => void => {
		return ConnectionManager.getInstance().on(event, handler);
	}, []);

	// --- Dispatch (deprecated shim) ---------------------------------------------

	/** @deprecated Routes prefs to updatePrefs, switchApp to connectionManager. */
	const dispatch = useCallback((action: { type: string; [key: string]: unknown }) => {
		if (action.type === 'prefs' && action.patch) {
			updatePrefs(action.patch as Partial<WorkspacePrefs>);
		} else if (action.type === 'switchApp' && action.appId) {
			ConnectionManager.getInstance().emit('shell:switchApp', { appId: action.appId as string });
		}
	}, [updatePrefs]);

	// --- Theme ---------------------------------------------------------------

	const themeOptions = themeOptionsProp ?? [];

	/** Switch theme — updates prefs, applies CSS, and persists to localStorage for unauthenticated sessions. */
	const setTheme = useCallback((themeId: string) => {
		updatePrefs({ theme: themeId });
		onThemeChange?.(themeId);
		try { localStorage.setItem('rr:theme', themeId); } catch {}
	}, [updatePrefs, onThemeChange]);

	return (
		<WorkspaceContext.Provider value={{
			loaded, seeded, appLoading,
			prefs,
			appState, updateAppState,
			activeAppId,
			appManifest: apps,
			loadedApps,
			loadApp: loadDescriptor,
			appLoadErrors, retryApp,
			settings, updateSetting,
			updatePrefs, themeOptions, setTheme, dispatch, emit, on,
		}}>
			{children}
		</WorkspaceContext.Provider>
	);
};

// =============================================================================
// HOOK
// =============================================================================

/**
 * Returns the `IWorkspaceContext` from the nearest `WorkspaceProvider` ancestor.
 *
 * Throws an informative error if called outside the provider tree, which makes
 * misconfigured component hierarchies immediately obvious during development.
 *
 * @returns The current workspace context value.
 */
export function useWorkspace(): IWorkspaceContext {
	const ctx = useContext(WorkspaceContext);
	if (!ctx) throw new Error('useWorkspace must be used within WorkspaceProvider');
	return ctx;
}
