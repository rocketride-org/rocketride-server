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
// APP REGISTRY CONTEXT
// =============================================================================
//
// Single source of truth for all registered apps in the shell.
//
// Updated from:
//   - Probe (bootstrap: home app)
//   - Desktop fetch (after login: user's desktop apps with subscription info)
//   - apaext_desktop push events (live desktop updates)
//   - On-demand single app fetch (loading an unknown app by ID)
//
// The catalog (rrext_public_catalog list) does NOT update this list.
// It feeds the store UI separately via useStoreApps.
//
// Every app that enters this registry is registered as an MF remote so
// it can be loaded by the shell.
// =============================================================================

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { AppManifestEntry } from '../workspace/types';
import { ConnectionManager } from '../connection/connection';
import { registerAndMapApps } from '../lib/appLoader';

// =============================================================================
// TYPES
// =============================================================================

/** Shape of the app registry context value. */
interface AppRegistryContextValue {
	/** All registered apps (with load() functions). */
	apps: AppManifestEntry[];

	/**
	 * Ensure an app is in the registry. If not found, fetches it from the
	 * catalog and registers the MF remote. Returns the entry, or null if
	 * the app could not be resolved.
	 */
	ensureApp: (appId: string) => Promise<AppManifestEntry | null>;

	/** Fetch the user's desktop apps and merge into the registry. */
	refreshDesktop: () => Promise<void>;
}

// =============================================================================
// CONTEXT
// =============================================================================

const AppRegistryContext = createContext<AppRegistryContextValue>({
	apps: [],
	ensureApp: async () => null,
	refreshDesktop: async () => {},
});

// =============================================================================
// PROVIDER
// =============================================================================

/**
 * Provider that maintains the single registered apps list.
 *
 * Seeded with initial apps (home app from probe) via the initialApps prop.
 * After auth, fetches desktop apps and merges them in. Listens for
 * apaext_desktop push events for live refresh.
 */
export const AppRegistryProvider: React.FC<{
	initialApps: AppManifestEntry[];
	children: React.ReactNode;
}> = ({ initialApps, children }) => {
	// Master app list — keyed by appId for dedup, stored as array for consumers
	const [apps, setApps] = useState<AppManifestEntry[]>(initialApps);
	// Ref mirror for use in callbacks without stale closures.
	// Updated synchronously inside the setApps updater (not in useEffect)
	// so ensureApp never reads a stale snapshot.
	const appsRef = useRef<AppManifestEntry[]>(initialApps);
	// Tracks any in-flight desktop fetch so ensureApp can wait for it
	const desktopFetchRef = useRef<Promise<void> | null>(null);
	// Guards the mount-time "already authenticated" fetch so a StrictMode
	// double-mount (or a login racing mount) can't fire the initial fetch twice.
	const initialFetchDoneRef = useRef(false);

	const cm = ConnectionManager.getInstance();

	// =========================================================================
	// MERGE HELPERS
	// =========================================================================

	/**
	 * Merge new app entries into the registry.
	 *
	 * Full entries (with an MF `entry` URL) are registered as remotes and
	 * added/replaced. Lean entries (e.g. an `apaext_desktop` membership push
	 * carrying only `id` + `onDesktop`) are patched onto EXISTING registry
	 * entries by id without requiring `entry` — otherwise the desktop
	 * add/remove would be silently dropped by the `entry` filter.
	 */
	const mergeApps = useCallback((incoming: Record<string, unknown>[]) => {
		const entries = incoming as AppManifestEntry[];
		// Only full entries (with a remoteEntry URL) can be registered as MF remotes.
		const registered = registerAndMapApps(entries.filter((a) => a.entry));
		// Lean entries patch existing registry rows (membership/status updates).
		const lean = entries.filter((a) => a && a.id && !a.entry);

		setApps((prev) => {
			// Build index of existing apps
			const byId = new Map(prev.map((a) => [a.id, a]));

			// Full entries: register/replace, overlaying new fields, keep load().
			for (const app of registered) {
				const existing = byId.get(app.id);
				byId.set(app.id, existing ? { ...existing, ...app } : app);
			}

			// Lean entries: patch onto existing rows only (no MF remote to load).
			for (const patch of lean) {
				const existing = byId.get(patch.id);
				if (existing) byId.set(patch.id, { ...existing, ...patch });
			}

			const result = Array.from(byId.values());
			// Synchronously update the ref so ensureApp sees fresh data
			appsRef.current = result;
			return result;
		});
	}, []);

	// =========================================================================
	// DESKTOP FETCH
	// =========================================================================

	/** Fetch the user's desktop apps and merge into the registry. */
	const refreshDesktop = useCallback(async () => {
		// Dedupe: if a fetch is already in flight, await the SAME promise instead
		// of starting a second one. Prevents concurrent callers (mount + login +
		// ensureApp) from racing multiple overlapping desktop fetches.
		if (desktopFetchRef.current) return desktopFetchRef.current;

		const doFetch = async () => {
			try {
				const client = cm.getClient();
				if (!client || !client.isAuthenticated()) return;
				const resp = await client.call('rrext_account_me', { subcommand: 'desktop' });
				const body = resp?.body ?? resp ?? {};
				const fetchedApps = body.apps ?? [];
				mergeApps(fetchedApps);
			} catch (err) {
				console.error('[AppRegistry] refreshDesktop() FAILED:', err);
			}
		};
		// Store the promise so ensureApp (and deduped callers) can wait for it.
		const p = doFetch();
		desktopFetchRef.current = p;
		try {
			await p;
		} finally {
			// Only clear if OUR promise is still the current one — never null out a
			// newer in-flight fetch that replaced ours.
			if (desktopFetchRef.current === p) desktopFetchRef.current = null;
		}
		return p;
	}, [cm, mergeApps]);

	// =========================================================================
	// ENSURE APP (on-demand single fetch)
	// =========================================================================

	/**
	 * Ensure an app is in the registry. If not found, fetches it from the
	 * server catalog, registers the MF remote, and adds it to the registry.
	 */
	const ensureApp = useCallback(async (appId: string): Promise<AppManifestEntry | null> => {
		// Check if already registered
		let existing = appsRef.current.find((a) => a.id === appId);
		if (existing) return existing;

		// If a desktop fetch is in flight, wait for it — the app may arrive
		if (desktopFetchRef.current) {
			await desktopFetchRef.current;
			// Re-check after desktop fetch completes
			existing = appsRef.current.find((a) => a.id === appId);
			if (existing) return existing;
		}

		// Fetch from catalog as last resort
		try {
			const client = cm.getClient();
			if (!client) return null;
			const resp = await client.call('rrext_public_catalog', {
				action: 'get', appId,
			});
			const appEntry = resp?.body;
			if (!appEntry?.entry || !appEntry?.moduleId) return null;

			// Register and add to the list
			const registered = registerAndMapApps([appEntry]);
			if (registered.length === 0) return null;

			const newApp = registered[0];
			setApps((prev) => {
				// Double-check another concurrent call didn't add it
				if (prev.find((a) => a.id === appId)) return prev;
				const result = [...prev, newApp];
				appsRef.current = result;
				return result;
			});
			return newApp;
		} catch (err) {
			console.error(`[AppRegistry] ensureApp: failed to fetch ${appId}`, err);
			return null;
		}
	}, [cm]);

	// =========================================================================
	// EVENT LISTENERS
	// =========================================================================

	useEffect(() => {
		// If already authenticated when the provider mounts, fetch desktop once.
		// The ref guard stops a StrictMode double-mount — or a shell:login that
		// races the mount — from firing the initial fetch a second time (the
		// refreshDesktop dedupe covers the concurrent case; this covers re-runs).
		const client = cm.getClient();
		if (client && client.isAuthenticated() && !initialFetchDoneRef.current) {
			initialFetchDoneRef.current = true;
			refreshDesktop();
		}

		// Desktop update push events
		const desktopListener = cm.on('shell:desktopUpdate', (payload: { apps: AppManifestEntry[] }) => {
			mergeApps(payload.apps ?? []);
		});

		// Fetch desktop on future logins
		const loginListener = cm.on('shell:login', () => {
			refreshDesktop();
		});

		// Clear subscription/desktop fields on logout (keep MF registrations)
		const logoutListener = cm.on('shell:logout', () => {
			setApps((prev) => {
				const result = prev.map((a) => ({
					...a, appStatus: undefined, onDesktop: undefined,
				}));
				appsRef.current = result;
				return result;
			});
		});

		return () => {
			desktopListener();
			loginListener();
			logoutListener();
		};
	}, [cm, refreshDesktop, mergeApps]);

	return (
		<AppRegistryContext.Provider value={{ apps, ensureApp, refreshDesktop }}>
			{children}
		</AppRegistryContext.Provider>
	);
};

// =============================================================================
// HOOK
// =============================================================================

/**
 * Access the app registry.
 *
 * Returns the registered apps list, an ensureApp function for on-demand
 * resolution, and a refreshDesktop function for manual refresh.
 */
export function useAppRegistry(): AppRegistryContextValue {
	return useContext(AppRegistryContext);
}
