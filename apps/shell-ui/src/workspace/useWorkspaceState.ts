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
// WORKSPACE STATE PERSISTENCE — per-app files
// =============================================================================

import { useState, useEffect, useRef, useCallback } from 'react';
import { RocketRideClient } from 'rocketride';
import type { AppWorkspaceState, WorkspacePrefs } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Milliseconds to wait after the last state change before writing to disk. */
const SAVE_DEBOUNCE_MS = 500;

// =============================================================================
// DEFAULT STATE
// =============================================================================

/**
 * Baseline preferences applied to every new app workspace session.
 * Individual fields can be overridden by persisted data loaded from disk.
 */
const defaultPrefs: WorkspacePrefs = {
	activeView: 'welcome',
	activeActivity: 'explorer',
	sidePanelOpen: true,
	theme: 'rocketride-light',
};

/**
 * Creates a fresh `AppWorkspaceState` for an app that has no saved state yet.
 *
 * @param _appId - The stable identifier of the app being initialised.
 * @returns A complete `AppWorkspaceState` with default prefs and empty appState.
 */
const makeDefaultAppState = (_appId: string): AppWorkspaceState => {
	// Restore theme from localStorage if available (persists across unauthenticated sessions)
	const savedTheme = (() => { try { return localStorage.getItem('rr:theme') || ''; } catch { return ''; } })();
	return {
		prefs: { ...defaultPrefs, ...(savedTheme ? { theme: savedTheme } : {}) },
		appState: {},
	};
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Returns true if the given client instance exposes the filesystem JSON API
 * (`fsReadJson` / `fsWriteJson`).  Used to gracefully degrade when the client
 * is a minimal stub that does not support persistence.
 *
 * @param client - The RocketRideClient instance to inspect.
 * @returns True if the client supports filesystem JSON operations.
 */
function hasStoreApi(client: RocketRideClient): boolean {
	return typeof (client as any).fsReadJson === 'function';
}

/**
 * Shape of the global workspace file (`global.json`).
 * Tracks the last active app and shell-wide preferences that span app switches.
 */
interface GlobalFile {
	version: 3;
	activeAppId: string;
	shellPrefs?: { theme?: string; sidePanelOpen?: boolean };
}

/**
 * Returns the path to the global workspace file within the given directory.
 *
 * @param dir - The workspace directory (e.g. ".workspace").
 * @returns The full path to global.json.
 */
function globalPath(dir: string) { return `${dir}/global.json`; }

/**
 * Returns the path to a specific app's workspace state file.
 *
 * @param dir   - The workspace directory.
 * @param appId - The app's stable identifier.
 * @returns The full path to the app's workspace JSON file.
 */
function appPath(dir: string, appId: string) { return `${dir}/${appId}.workspace.json`; }

/**
 * Returns the path to the shared settings file within the workspace directory.
 *
 * @param dir - The workspace directory.
 * @returns The full path to settings.json.
 */
function settingsPath(dir: string) { return `${dir}/settings.json`; }

// =============================================================================
// HOOK
// =============================================================================

/**
 * Manages the full workspace persistence lifecycle: initial load from disk,
 * debounced saves on state change, and coordinated app switching.
 *
 * All state for every app is stored in separate per-app JSON files under
 * `workspaceDir`.  A `global.json` file tracks the active app ID and shared
 * shell preferences (theme, side panel state) so they survive app switches.
 *
 * @param client        - Live RocketRideClient; null while connecting.
 * @param isConnected   - Whether the WebSocket is currently open.
 * @param defaultAppId  - App to activate if no saved global state exists.
 * @param workspaceDir  - Directory for all persistence files (default ".workspace").
 * @param startupAppId  - Optional override for the active app on first load.
 * @returns State values and mutation callbacks consumed by WorkspaceContext.
 */
export function useWorkspaceState(
	client: RocketRideClient | null,
	isConnected: boolean,
	defaultAppId: string,
	workspaceDir: string = '.workspace',
	startupAppId?: string,
) {
	// `loaded` becomes true once the initial disk read (or no-op) has completed
	const [loaded, setLoaded] = useState(false);
	// The appId of the currently active app
	const [activeAppId, setActiveAppId] = useState<string>(defaultAppId);
	// In-memory map of all app workspace states loaded during this session
	const [apps, setApps] = useState<Record<string, AppWorkspaceState>>({});
	// Persisted key/value settings (e.g. API keys) loaded from settings.json
	const [settings, setSettings] = useState<Record<string, string>>({});
	// Ref mirror of settings for use inside callbacks without stale closures
	const settingsRef = useRef<Record<string, string>>({});
	// Pending debounce timer handle for settings writes
	const settingsSaveRef = useRef<ReturnType<typeof setTimeout>>();

	// Refs for immediate (non-debounced) saves used during app switches
	const appsRef = useRef<Record<string, AppWorkspaceState>>({});
	const activeAppIdRef = useRef<string>(defaultAppId);
	// Pending debounce timer handle for per-app workspace writes
	const saveRef = useRef<ReturnType<typeof setTimeout>>();
	// Pending debounce timer handle for global.json writes
	const globalSaveRef = useRef<ReturnType<typeof setTimeout>>();
	// Guards to prevent duplicate pre-auth seeding and disk loads
	const preAuthSeededRef = useRef(false);
	const [seeded, setSeeded] = useState(false);
	const diskLoadedRef = useRef(false);

	// Keep refs in sync with state
	useEffect(() => { appsRef.current = apps; }, [apps]);
	useEffect(() => { activeAppIdRef.current = activeAppId; }, [activeAppId]);
	useEffect(() => { settingsRef.current = settings; }, [settings]);

	// --- Selectors (active app's data) ---------------------------------------

	// Derive the active app's state slice; fall back to a fresh default if not yet loaded
	const activeApp = apps[activeAppId] ?? makeDefaultAppState(activeAppId);
	const prefs = activeApp.prefs;
	const appState = activeApp.appState;

	// --- Persistence helpers -------------------------------------------------

	/**
	 * Returns true when it is safe to write to the RocketRide filesystem API.
	 * All three conditions must hold: client exists, WebSocket is open, and the
	 * client exposes the fsReadJson/fsWriteJson methods.
	 *
	 * @returns True if persistence writes are safe to perform.
	 */
	const canSave = useCallback(() => {
		return client != null && isConnected && hasStoreApi(client);
	}, [client, isConnected]);

	// In-memory cache of the latest shell-wide prefs to include in global.json writes
	const shellPrefsRef = useRef<{ theme?: string; sidePanelOpen?: boolean }>({});

	/**
	 * Debounced write of global.json for the given active app.
	 * Resets the debounce timer on each call so rapid app switches coalesce.
	 *
	 * @param appId - The app that should be recorded as active in global.json.
	 */
	const writeGlobal = useCallback((appId: string) => {
		if (!canSave()) return;
		// Cancel any pending timer so only the most recent call wins
		clearTimeout(globalSaveRef.current);
		globalSaveRef.current = setTimeout(() => {
			client!.fsWriteJson(globalPath(workspaceDir), { version: 3, activeAppId: appId, shellPrefs: shellPrefsRef.current }).catch(() => {});
		}, SAVE_DEBOUNCE_MS);
	}, [canSave, client, workspaceDir]);

	/**
	 * Merges a partial shell preference patch into the in-memory ref and
	 * triggers a debounced global.json write.
	 *
	 * @param patch - Partial override of theme and/or sidePanelOpen.
	 * @param appId - The current active app ID to record alongside the prefs.
	 */
	const writeGlobalPrefs = useCallback((patch: { theme?: string; sidePanelOpen?: boolean }, appId: string) => {
		// Merge the patch into the cached shell prefs
		shellPrefsRef.current = { ...shellPrefsRef.current, ...patch };
		// Schedule (or debounce) a global.json write
		writeGlobal(appId);
	}, [writeGlobal]);

	/**
	 * Debounced write of a single app's workspace state to its per-app JSON file.
	 *
	 * @param appId - The app whose state should be persisted.
	 * @param state - The full `AppWorkspaceState` to write.
	 */
	const writeAppState = useCallback((appId: string, state: AppWorkspaceState) => {
		if (!canSave()) return;
		// Cancel any pending timer; the latest call wins
		clearTimeout(saveRef.current);
		saveRef.current = setTimeout(() => {
			client!.fsWriteJson(appPath(workspaceDir, appId), state).catch(() => {});
		}, SAVE_DEBOUNCE_MS);
	}, [canSave, client, workspaceDir]);

	/**
	 * Immediate (non-debounced) write of a single app's workspace state.
	 * Used just before an app switch so no in-flight debounce is lost.
	 *
	 * @param appId - The app whose state should be flushed immediately.
	 * @param state - The full `AppWorkspaceState` to write.
	 */
	const writeAppStateNow = useCallback((appId: string, state: AppWorkspaceState) => {
		if (!canSave()) return;
		// Write immediately — no setTimeout wrapper
		client!.fsWriteJson(appPath(workspaceDir, appId), state).catch(() => {});
	}, [canSave, client, workspaceDir]);

	/**
	 * Debounced write of the settings key/value map to `settings.json`.
	 *
	 * @param s - The complete settings object to persist.
	 */
	const writeSettings = useCallback((s: Record<string, string>) => {
		if (!canSave()) return;
		// Cancel any pending timer so rapid successive updates are batched
		clearTimeout(settingsSaveRef.current);
		settingsSaveRef.current = setTimeout(() => {
			client!.fsWriteJson(settingsPath(workspaceDir), s).catch(() => {});
		}, SAVE_DEBOUNCE_MS);
	}, [canSave, client, workspaceDir]);

	// --- Load on first connect (or seed defaults pre-auth) -------------------

	useEffect(() => {
		// Wait for the client singleton to be initialized
		if (!client) return;

		if (!isConnected) {
			// Pre-auth: seed default workspace state so the shell can render
			// unauthenticated apps (e.g. home) before auth completes.
			// Do NOT set loaded here — loaded means workspace is loaded from disk.
			if (!preAuthSeededRef.current) {
				preAuthSeededRef.current = true;
				const appId = startupAppId ?? defaultAppId;
				setActiveAppId(appId);
				setApps({ [appId]: makeDefaultAppState(appId) });
				setSeeded(true);
			}
			return;
		}

		// Connected: do the full disk load once (skip if already done)
		if (diskLoadedRef.current) return;
		diskLoadedRef.current = true;

		// Graceful degradation: client without filesystem API
		if (!hasStoreApi(client)) {
			if (!loaded) {
				setApps({ [defaultAppId]: makeDefaultAppState(defaultAppId) });
				setSeeded(true);
				setLoaded(true);
			}
			return;
		}

		// Load global prefs and settings in parallel
		Promise.all([
			client.fsReadJson<GlobalFile>(globalPath(workspaceDir)).catch(() => null),
			client.fsReadJson<Record<string, string>>(settingsPath(workspaceDir)).catch(() => null),
		]).then(async ([global, savedSettings]) => {
				// Active app: URL deep-link or built-in default
				const restoredAppId = startupAppId ?? defaultAppId;

				// Restore shell-global prefs
				if (global?.shellPrefs) shellPrefsRef.current = global.shellPrefs;

				// Attempt to load the restored app's per-app workspace file
				let appStateData: AppWorkspaceState | undefined;
				try {
					const raw = await client.fsReadJson<AppWorkspaceState>(appPath(workspaceDir, restoredAppId));
					// Accept the file if it has the minimum required shape
					if (raw?.prefs) appStateData = raw;
				} catch { /* no saved state */ }

				// Build the resolved state, overlaying global prefs
				const baseState = appStateData ?? makeDefaultAppState(restoredAppId);
				const sp = global?.shellPrefs;
				const mergedState: AppWorkspaceState = sp ? {
					...baseState,
					prefs: {
						...baseState.prefs,
						...(sp.theme !== undefined && { theme: sp.theme }),
						...(sp.sidePanelOpen !== undefined && { sidePanelOpen: sp.sidePanelOpen }),
					},
				} : baseState;

				// Ensure appState exists (handle v2 files that don't have it)
				if (!mergedState.appState) mergedState.appState = {};

				// Commit the resolved state — setLoaded must be in the same
				// microtask as setApps so React batches them into one render.
				// Otherwise consumers see loaded=true with stale empty appState.
				setActiveAppId(restoredAppId);
				setApps({ [restoredAppId]: mergedState });
				if (savedSettings && typeof savedSettings === 'object') setSettings(savedSettings);
				setSeeded(true);
				setLoaded(true);
			})
			.catch(() => {
				// Load failure — seed defaults
				setActiveAppId(defaultAppId);
				setApps({ [defaultAppId]: makeDefaultAppState(defaultAppId) });
				setSeeded(true);
				setLoaded(true);
			});
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client, isConnected]);

	// --- Debounced save on state changes -------------------------------------

	// Track whether we've seen the first post-load render to skip the
	// redundant write-back of what we just read from disk.
	const firstPostLoadRef = useRef(true);

	useEffect(() => {
		// Skip writes before the initial load to avoid overwriting disk with defaults
		if (!loaded) return;
		// Skip the first post-load render — we just read this data from disk,
		// writing it back immediately risks racing with Documents init which
		// may not have restored its state yet.
		if (firstPostLoadRef.current) {
			firstPostLoadRef.current = false;
			return;
		}
		const state = apps[activeAppId];
		if (state) writeAppState(activeAppId, state);
	}, [apps, activeAppId, loaded, writeAppState]);

	// --- Persist global prefs when theme or sidePanelOpen changes ------------

	const firstGlobalWriteRef = useRef(true);

	useEffect(() => {
		if (!loaded) return;
		// Skip the first post-load render — prefs were just loaded from disk
		if (firstGlobalWriteRef.current) {
			firstGlobalWriteRef.current = false;
			return;
		}
		// Build a patch containing only the fields we mirror in global.json
		const patch: { theme?: string; sidePanelOpen?: boolean } = {};
		if (prefs.theme !== undefined) patch.theme = prefs.theme;
		if (prefs.sidePanelOpen !== undefined) patch.sidePanelOpen = prefs.sidePanelOpen;
		writeGlobalPrefs(patch, activeAppId);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [prefs.theme, prefs.sidePanelOpen, loaded]);

	// --- App switch ----------------------------------------------------------

	/**
	 * Switches the active app: flushes the current app's state to disk
	 * immediately, loads the new app's state from disk (or seeds defaults),
	 * overlays global prefs for visual consistency, then updates React state.
	 *
	 * @param newAppId - The appId to switch to.
	 */
	const switchApp = useCallback(async (newAppId: string) => {
		// No-op if already on the requested app
		if (newAppId === activeAppIdRef.current) return;

		// 1. Immediately flush current app state (no debounce)
		clearTimeout(saveRef.current);
		const currentState = appsRef.current[activeAppIdRef.current];
		if (currentState) writeAppStateNow(activeAppIdRef.current, currentState);

		// 1b. Clear all server-side monitor subscriptions from the outgoing app
		// so the next app starts with a clean slate, and update the connection
		// display name so the server monitor shows which app is active
		if (client) {
			try {
				await client.clearAllMonitors();
			} catch (err) {
				console.error('[Workspace] Failed to clear monitors on app switch:', err);
			}
			client.identify(`Cloud Shell-UI \u2014 ${newAppId}`).catch(() => {});
		}

		// 2. Load new app state if not already in memory
		let newState = appsRef.current[newAppId];
		if (!newState && client && isConnected && hasStoreApi(client)) {
			try {
				const raw = await client.fsReadJson<AppWorkspaceState>(appPath(workspaceDir, newAppId));
				if (raw?.prefs) newState = raw;
			} catch { /* no saved state for this app */ }
		}
		if (!newState) newState = makeDefaultAppState(newAppId);

		// Ensure appState exists (handle v2 files)
		if (!newState.appState) newState.appState = {};

		// Overlay global prefs for consistency
		const sp = shellPrefsRef.current;
		newState = {
			...newState,
			prefs: {
				...newState.prefs,
				...(sp.theme !== undefined && { theme: sp.theme }),
				...(sp.sidePanelOpen !== undefined && { sidePanelOpen: sp.sidePanelOpen }),
			},
		};

		// 3. Update state
		setApps((prev) => ({ ...prev, [newAppId]: newState! }));
		setActiveAppId(newAppId);

		// 4. Persist global
		writeGlobal(newAppId);
	}, [client, isConnected, workspaceDir, writeAppStateNow, writeGlobal]);

	// --- Helper: mutate the active app's state --------------------------------

	/**
	 * Applies an updater function to the currently active app's workspace slice.
	 *
	 * @param updater - A pure function from current AppWorkspaceState to a new one.
	 */
	const updateActiveApp = useCallback((updater: (prev: AppWorkspaceState) => AppWorkspaceState) => {
		setApps((prev) => {
			const current = prev[activeAppIdRef.current] ?? makeDefaultAppState(activeAppIdRef.current);
			return { ...prev, [activeAppIdRef.current]: updater(current) };
		});
	}, []);

	// --- Preference mutations ------------------------------------------------

	/**
	 * Applies a partial preferences patch to the active app's prefs object.
	 *
	 * @param patch - Partial `WorkspacePrefs` fields to merge.
	 */
	const updatePrefs = useCallback((patch: Partial<WorkspacePrefs>) => {
		updateActiveApp((s) => ({ ...s, prefs: { ...s.prefs, ...patch } }));
	}, [updateActiveApp]);

	// --- Opaque app state mutations ------------------------------------------

	/**
	 * Replaces the active app's opaque appState using a functional updater.
	 * Used by the Documents library to persist open docs, editors, groups, etc.
	 *
	 * @param updater - A function from the current appState to a new one.
	 */
	const updateAppState = useCallback((updater: (prev: Record<string, unknown>) => Record<string, unknown>) => {
		updateActiveApp((s) => ({ ...s, appState: updater(s.appState) }));
	}, [updateActiveApp]);

	// --- Settings mutations --------------------------------------------------

	/**
	 * Persists a single setting key/value pair to the in-memory settings map and
	 * schedules a debounced write to `settings.json`.
	 *
	 * @param key   - The setting key (e.g. 'ROCKETRIDE_OPENAI_KEY').
	 * @param value - The new value to store.
	 */
	const updateSetting = useCallback((key: string, value: string) => {
		setSettings((prev) => {
			const next = { ...prev, [key]: value };
			settingsRef.current = next;
			writeSettings(next);
			return next;
		});
	}, [writeSettings]);

	return {
		loaded,
		seeded,
		activeAppId,
		prefs,
		appState,
		settings,
		switchApp,
		updatePrefs,
		updateAppState,
		updateSetting,
	};
}
