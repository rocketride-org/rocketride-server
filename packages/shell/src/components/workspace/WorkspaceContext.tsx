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

import React, { createContext, useContext, useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { useShellConnection } from '../../connection/ConnectionContext';
import { useWorkspaceState } from '../../hooks/useWorkspaceState';
import { buildSettingsRegistry, effectiveSettings } from './settingsRegistry';
import type { SettingsRegistry } from './settingsRegistry';
import type { WorkspacePrefs, AppDescriptor, AppManifestEntry, SettingValue } from './types';
import type { ShellConnectionEventMap } from '../../types/shell';
import { GRID_CONFIG_GET, GRID_CONFIG_SET, GRID_CONFIG_CLEAR } from '../data-grid/gridConfigChannel';
import type { IGridConfigGetDetail, IGridConfigSetDetail, IGridConfigClearDetail } from '../data-grid/gridConfigChannel';
import type { DataGridLayout } from '../data-grid/persistence';
import { ConnectionManager } from '../../connection/connection';
import { HOME_APP_ID, HELLO_APP_ID } from '../../constants';
import { resetRemote, setDescriptorInvalidator } from '../../util/appLoader';
import { SHELL_API_VERSION } from '../../apiver';

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
		// Both home apps count as "home": rocketride.home (SaaS) and
		// rocketride.hello (OSS) — returning to either clears the session lock.
		if (appId === HOME_APP_ID || appId === HELLO_APP_ID) {
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
	/**
	 * Clears the recorded load error for an app and re-attempts its descriptor
	 * load. Resolves true when the re-attempt succeeded.
	 */
	retryApp: (appId: string) => Promise<boolean>;
	/**
	 * Evicts an app's cached descriptor so its next activation loads fresh.
	 * When the app is currently active, the reload happens immediately — the
	 * fresh descriptor's new component identities force a full remount (no
	 * state preservation; that is the intended semantic). Used by the dev
	 * hooks (local app injection) and by entry-URL change reconciliation.
	 */
	invalidateApp: (appId: string) => void;
	/**
	 * Set when a switch-to-app failed to load while another app stayed on
	 * screen — surfaced by the shell as a modal over the current app.
	 * Null when no failure is pending.
	 */
	loadFailure: { appId: string; name: string } | null;
	/** Dismisses the pending load-failure modal. */
	dismissLoadFailure: () => void;
	/**
	 * EFFECTIVE settings — every declared default overlaid with the user's
	 * stored overrides, keyed by dotted appId-prefixed key
	 * (e.g. 'rocketride.models.serverHost').  Each value keeps its declared JSON
	 * type (string | number | boolean).  Reading a setting is a plain lookup —
	 * the default-merge already happened here.
	 */
	settings: Record<string, SettingValue>;
	/**
	 * RAW overrides as stored in settings.json (deltas only).  A key present
	 * here means "modified from default" — this is what the settings page's
	 * modified indicator and reset action read.
	 */
	settingsOverrides: Record<string, SettingValue>;
	/** Flattened declarations from all desktop apps' configurations. */
	settingsRegistry: SettingsRegistry;
	/**
	 * Persist a single setting value.  Writing a value equal to the schema
	 * default DELETES the override (deltas-only storage); passing `undefined`
	 * resets the key to its default explicitly.
	 */
	updateSetting: (key: string, value: SettingValue | undefined) => void;
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
	on<K extends keyof ShellConnectionEventMap>(event: K, handler: (payload: ShellConnectionEventMap[K]) => void): () => void;
	/** Open-set overload — the event set grows; see IConnectionManager.on (shared). */
	on(event: string, handler: (payload: unknown) => void): () => void;
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
 * Props for {@link WorkspaceProvider}.
 *
 * The connection (client + isConnected) is deliberately NOT a prop: the
 * provider reads it from {@link useShellConnection} like every other shell
 * component. Threading the client through props would put the SDK client in
 * an input (contravariant) position on the frozen shell-api surface, where
 * every additive SDK member would read as a breaking change.
 */
export interface IWorkspaceProviderProps {
	/** Array of lightweight app manifest entries. */
	apps: AppManifestEntry[];
	/** Directory for workspace persistence files (default ".workspace"). */
	workspaceDir?: string;
	/** Optional app to activate on initial load (overrides saved state). */
	startupAppId?: string;
	/** React subtree that will receive the context. */
	children: React.ReactNode;
	/** Fallback app when no saved state / startup override exists. */
	defaultAppId?: string;
	/** Selectable UI themes surfaced in the settings page. */
	themeOptions?: { id: string; name: string }[];
	/** Notifies the host bootstrap when the user switches theme. */
	onThemeChange?: (themeId: string) => void;
}

/**
 * Provides workspace state, lazy app descriptor loading, and the shell event
 * bus to the entire React tree beneath it. Sources the RocketRide client and
 * connection state from the ConnectionManager singleton via
 * {@link useShellConnection} (provider-less; re-renders on connect events).
 *
 * @param props - See {@link IWorkspaceProviderProps}.
 */
export const WorkspaceProvider: React.FC<IWorkspaceProviderProps> = ({ apps, workspaceDir, startupAppId, defaultAppId: defaultAppIdProp, themeOptions: themeOptionsProp, onThemeChange, children }) => {
	// The shared client + connection state, straight from the singleton — the
	// same source Shell reads; no prop threading.
	const { client, isConnected } = useShellConnection();

	// Default app ID — use the prop from Shell (mode-aware), or fall back to hello.
	const defaultAppId = defaultAppIdProp || 'rocketride.hello';

	// Destructure all state and mutation helpers from the persistence hook
	const {
		loaded, seeded, activeAppId, prefs, appState, settings: settingsOverrides,
		switchApp, updatePrefs, updateAppState, updateSetting: writeSettingOverride,
	} = useWorkspaceState(client, isConnected, defaultAppId, workspaceDir, startupAppId);

	// ── Settings registry + effective values ───────────────────────────────
	// The registry flattens every desktop app's configuration (VSCode
	// contributes.configuration shape) into one declaration index.  It rebuilds
	// whenever the manifest changes (connect / shell:accountUpdate deliver a new
	// `apps` array).  Effective settings = declared defaults + stored overrides.
	const settingsRegistry = useMemo(() => buildSettingsRegistry(apps), [apps]);
	// Effective values keep their declared JSON type (string | number | boolean).
	// The settings page reads settingsOverrides + registry defaults for its
	// controls; every other app reads this merged effective map.
	const settings = useMemo(
		() => effectiveSettings(settingsRegistry, settingsOverrides),
		[settingsRegistry, settingsOverrides],
	);

	/**
	 * Persists a setting change with deltas-only semantics: a value equal to
	 * the schema default deletes the override instead of storing it, so
	 * settings.json only ever contains deviations from the defaults.
	 *
	 * @param key   - The dotted setting key.
	 * @param value - The new value, or undefined to reset to default.
	 */
	const updateSetting = useCallback((key: string, value: SettingValue | undefined) => {
		const def = settingsRegistry.defaults[key];
		// Equal to the declared default → remove the override entirely
		writeSettingOverride(key, value !== undefined && value === def ? undefined : value);
	}, [settingsRegistry, writeSettingOverride]);

	// ── Grid config channel bridge (web host) ──────────────────────────────
	// Answers shared-ui DataGrid persistence over the document CustomEvent
	// channel from THIS app's workspace prefs (`prefs.tableLayouts`). The
	// bridge is what lets shared components persist layouts WITHOUT importing
	// shell: grids dispatch, the active app's provider answers. `get` must
	// reply synchronously (Tabulator's reader is sync) — hence the live ref;
	// `set`/`clear` merge over the freshest map so several grids in one view
	// never clobber each other's entries.
	const gridPrefsRef = useRef(prefs);
	gridPrefsRef.current = prefs;
	useEffect(() => {
		/** The current per-table layout map from the live prefs. */
		const layoutMap = (): Record<string, DataGridLayout> => {
			const stored = gridPrefsRef.current.tableLayouts;
			return stored && typeof stored === 'object' ? { ...(stored as Record<string, DataGridLayout>) } : {};
		};
		const onGet = (event: Event): void => {
			const detail = (event as CustomEvent<IGridConfigGetDetail>).detail;
			detail.reply(layoutMap()[detail.tableId]);
		};
		const onSet = (event: Event): void => {
			const detail = (event as CustomEvent<IGridConfigSetDetail>).detail;
			const map = layoutMap();
			map[detail.tableId] = { ...map[detail.tableId], [detail.type]: detail.blob };
			updatePrefs({ tableLayouts: map });
		};
		const onClear = (event: Event): void => {
			const detail = (event as CustomEvent<IGridConfigClearDetail>).detail;
			const map = layoutMap();
			delete map[detail.tableId];
			updatePrefs({ tableLayouts: map });
		};
		document.addEventListener(GRID_CONFIG_GET, onGet);
		document.addEventListener(GRID_CONFIG_SET, onSet);
		document.addEventListener(GRID_CONFIG_CLEAR, onClear);
		return () => {
			document.removeEventListener(GRID_CONFIG_GET, onGet);
			document.removeEventListener(GRID_CONFIG_SET, onSet);
			document.removeEventListener(GRID_CONFIG_CLEAR, onClear);
		};
	}, [updatePrefs]);

	// --- Lazy descriptor loading -----------------------------------------------

	// Map of fully loaded AppDescriptors, keyed by appId
	const [loadedApps, setLoadedApps] = useState<Record<string, AppDescriptor>>({});
	// True while any app descriptor dynamic import is in flight
	const [appLoading, setAppLoading] = useState(false);
	// Ref mirror of loadedApps so loadDescriptor's closure never stales
	const loadedAppsRef = useRef<Record<string, AppDescriptor>>({});
	// In-flight descriptor loads by appId. A Map (not a Set) so concurrent
	// callers can AWAIT the existing load instead of treating "in flight" as
	// "ready" — shell:switchApp must not switch before the descriptor lands.
	const loadingMapRef = useRef<Map<string, Promise<boolean>>>(new Map());
	// Tracks appIds whose load has FAILED so the auto-load effect won't silently
	// re-attempt them (only retryApp clears this). Directly mutated, like loadingMapRef.
	const failedSetRef = useRef<Set<string>>(new Set());
	// Per-app descriptor load-failure messages, keyed by appId (surfaced to the UI
	// so a failed remote shows an error + Retry instead of an indefinite "Loading…")
	const [appLoadErrors, setAppLoadErrors] = useState<Record<string, string>>({});

	// A failed switch-to-app while another app stayed on screen — rendered by
	// ShellLayout as a modal over the current app rather than a page takeover.
	const [loadFailure, setLoadFailure] = useState<{ appId: string; name: string } | null>(null);

	/** Dismisses the pending load-failure modal. */
	const dismissLoadFailure = useCallback(() => setLoadFailure(null), []);

	// Keep the ref mirror up to date
	useEffect(() => { loadedAppsRef.current = loadedApps; }, [loadedApps]);

	/**
	 * Dynamically imports the AppDescriptor for the given appId.
	 *
	 * Guards against duplicate loads and concurrent loads.  Sets `appLoading`
	 * to true for the duration and clears it once all in-flight loads complete.
	 *
	 * @param appId - The app whose descriptor should be loaded.
	 * @returns True when the descriptor is (or already was) loaded or in
	 *          flight; false when the app is unavailable (failed / unknown).
	 */
	const loadDescriptor = useCallback(async (appId: string): Promise<boolean> => {
		// Skip if already loaded
		if (loadedAppsRef.current[appId]) { return true; }
		// A load is already in flight: await ITS outcome rather than reporting
		// ready — otherwise shell:switchApp switches before the descriptor lands.
		const inFlight = loadingMapRef.current.get(appId);
		if (inFlight) { return inFlight; }
		// Skip if this app already failed — only retryApp re-attempts it (it clears
		// failedSetRef first), so the auto-load effect can't silently re-arm the load.
		if (failedSetRef.current.has(appId)) { return false; }
		// Find the manifest entry
		const entry = apps.find((a) => a.id === appId);
		if (!entry) return false;

		// Forward-compat gate: an app stamped with a NEWER shell-api version
		// than this shell provides would load, then hit undefined API members
		// at runtime. Fail fast with a clear message instead. (shellApiVersion
		// is stamped into apps.json by the app registration step; absent on
		// older manifests, which pass the gate.)
		if (typeof entry.shellApiVersion === 'number' && entry.shellApiVersion > SHELL_API_VERSION) {
			failedSetRef.current.add(appId);
			setAppLoadErrors((prev) => ({ ...prev, [appId]: `${entry.name} requires shell API v${entry.shellApiVersion}, but this platform provides v${SHELL_API_VERSION}. Update the platform to run this app.` }));
			return false;
		}

		// Mark as in-flight and raise loading flag
		setAppLoading(true);
		// A fresh (re)attempt clears any stale error recorded for this app
		setAppLoadErrors((prev) => { if (!prev[appId]) return prev; const next = { ...prev }; delete next[appId]; return next; });
		// The load body runs as its own promise so concurrent callers can await
		// it via the map. The leading microtask yield guarantees the map entry
		// below is registered before any of the body (or its finally) executes.
		const load = (async (): Promise<boolean> => {
		await Promise.resolve();
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
				return false;
			}

			setLoadedApps((prev) => ({ ...prev, [appId]: descriptor }));
			return true;
		} catch (e) {
			// message + stack explicitly: Error objects JSON-stringify to {}
			// through console forwarding, hiding the actual failure.
			console.error(`[WorkspaceContext] Failed to load AppDescriptor for "${appId}": ${e instanceof Error ? (e.stack || e.message) : String(e)}`);
			failedSetRef.current.add(appId);
			setAppLoadErrors((prev) => ({ ...prev, [appId]: (e instanceof Error ? e.message : String(e)) || `App "${appId}" failed to load.` }));
			return false;
		} finally {
			loadingMapRef.current.delete(appId);
			if (loadingMapRef.current.size === 0) setAppLoading(false);
		}
		})();
		loadingMapRef.current.set(appId, load);
		return load;
	}, [apps]);

	/**
	 * Re-attempts an app's descriptor load after a failure. Clears the failure
	 * marker synchronously (failedSetRef is what stops the auto-load effect from
	 * silently re-trying a down app, so an explicit retry must clear it first);
	 * loadDescriptor itself clears the displayed error when the attempt starts.
	 */
	const retryApp = useCallback((appId: string): Promise<boolean> => {
		failedSetRef.current.delete(appId);
		// Tear down the half-initialized MF container first so the retry does a
		// REAL fresh fetch — re-loading the cached failed container only throws
		// TDZ errors ("Cannot access 'x' before initialization").
		const entry = apps.find((a) => a.id === appId);
		if (entry?.moduleId) resetRemote(entry.moduleId);
		return loadDescriptor(appId);
	}, [apps, loadDescriptor]);

	/**
	 * Evicts an app's cached descriptor (and all failure bookkeeping) so the
	 * next activation loads fresh. If the app is ACTIVE, kicks the reload
	 * immediately: the replacement descriptor carries new component
	 * identities, so React fully remounts the app (intended — no state
	 * preservation). The ref mirror is cleared synchronously so a
	 * loadDescriptor racing this call cannot early-return on stale cache.
	 */
	const invalidateDescriptor = useCallback((appId: string): void => {
		// Synchronous eviction from the ref mirror + failure bookkeeping
		delete loadedAppsRef.current[appId];
		failedSetRef.current.delete(appId);
		// State eviction (descriptor + surfaced error)
		setLoadedApps((prev) => { if (!(appId in prev)) return prev; const next = { ...prev }; delete next[appId]; return next; });
		setAppLoadErrors((prev) => { if (!prev[appId]) return prev; const next = { ...prev }; delete next[appId]; return next; });
		// Active app: reload now so the screen swaps to the fresh descriptor
		if (appId === activeAppId) void loadDescriptor(appId);
	}, [activeAppId, loadDescriptor]);

	// Publish the invalidator on the appLoader bridge so non-React code
	// (Shell's entry-change reconciliation, window.__rrShellDev) can evict
	// descriptors. Not dev-gated — production entry changes invalidate too.
	useEffect(() => {
		setDescriptorInvalidator(invalidateDescriptor);
		return () => setDescriptorInvalidator(null);
	}, [invalidateDescriptor]);

	// Load the active app's descriptor once workspace state is ready
	// (seeded is enough — don't wait for the full disk load)
	useEffect(() => {
		if (loaded || seeded) loadDescriptor(activeAppId);
	}, [loaded, seeded, activeAppId, loadDescriptor]);

	// --- shell:switchApp → programmatic app switch ----------------------------

	// Monotonic switch-request counter: an in-flight load-before-switch bails
	// out after its await when a newer request has superseded it, so rapid
	// switches settle on the last CLICKED app, not the last load to resolve.
	const switchSeqRef = useRef(0);

	useEffect(() => {
		/** Allows non-React code to switch the active app without having
		 *  access to WorkspaceContext dispatch. */
		return ConnectionManager.getInstance().on('shell:switchApp', async ({ appId }) => {
			// Claim a sequence number FIRST: even an instant (already-loaded)
			// switch must invalidate any older in-flight load-before-switch.
			const mySeq = ++switchSeqRef.current;
			// Resolve $HOME to the platform default, and unknown appIds to the default
			const target = appId === '$HOME' ? defaultAppId : appId;
			const resolved = apps.find((a) => a.id === target) ? target : defaultAppId;
			const entry = apps.find((a) => a.id === resolved);

			// Already loaded → instant switch, exactly as before.
			if (loadedAppsRef.current[resolved]) {
				switchApp(resolved);
				persistActiveApp(resolved);
				pushAppHistory(resolved);
				return;
			}

			// Load-before-switch: the CURRENT app stays on screen (and interactive)
			// while the target loads, so a broken target never tears down a working
			// one. The status bar shows progress. On failure we still navigate, so
			// the friendly error view (with its Show Details debugging panel) shows.
			const cm = ConnectionManager.getInstance();
			cm.emit('shell:statusMessage', { message: `Loading ${entry?.name ?? resolved}…` });
			const ok = await loadDescriptor(resolved);
			cm.emit('shell:statusMessage', { message: null });

			// A newer switchApp superseded this one while we awaited the load —
			// last CLICK wins, not last-to-resolve; and a stale failure must not
			// pop its modal over an app the user has already moved on to.
			if (mySeq !== switchSeqRef.current) return;

			if (ok) {
				switchApp(resolved);
				persistActiveApp(resolved);
				pushAppHistory(resolved);
			} else {
				// Stay on the current app; surface the failure as a modal over it.
				setLoadFailure({ appId: resolved, name: entry?.name ?? resolved });
			}
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
			appLoadErrors, retryApp, invalidateApp: invalidateDescriptor,
			loadFailure, dismissLoadFailure,
			settings, settingsOverrides, settingsRegistry, updateSetting,
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
