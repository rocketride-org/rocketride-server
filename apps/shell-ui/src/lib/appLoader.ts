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

/**
 * App loader — converts server-provided app entries into runtime
 * AppManifestEntry objects with Module Federation lazy loaders.
 *
 * Used by both bootstrap.tsx (initial probe) and Shell.tsx (post-auth
 * app replacement) to register MF remotes and wrap them with load().
 */

import { registerRemotes, loadRemote } from '@module-federation/runtime';
import type { AppManifestEntry, AppDescriptor, AppConfiguration } from '../workspace/types';

/**
 * Shape of an app entry from the server (rrext_public_probe or ConnectResult).
 * Matches the AppManifestEntry from the client SDK but without the load() function.
 */
export interface ServerAppEntry {
	/** Unique app identifier (e.g. "rocketride.hello"). */
	id: string;
	/** Module Federation remote name (e.g. "rocketride_hello"). */
	moduleId: string;
	/** Human-readable app name. */
	name: string;
	/** Short description. */
	description?: string;
	/** URL path to the app's icon. */
	icon?: string;
	/** Category tags. */
	categories?: string[];
	/** Settings contribution (VSCode contributes.configuration shape). */
	configuration?: unknown;
	/** @deprecated Legacy flat settings list from pre-configuration servers. */
	settings?: unknown[];
	/** URL to the MF remote entry file. */
	entry: string;
	/** Whether the app UI requires auth to render. */
	authenticated?: boolean;
	/** Whether to show the header bar. */
	showHeader?: boolean;
	/** Whether to show the status bar. */
	showStatusBar?: boolean;
	/** Whether the app is visible to unauthenticated users. */
	public?: boolean;
}

/**
 * Register server-provided apps as Module Federation remotes and wrap
 * each with a lazy `load()` function.
 *
 * Called at bootstrap with public apps from the server probe, and again
 * after auth with the user's full entitled app set from ConnectResult.
 *
 * @param serverApps - App entries from the server.
 * @returns Array of AppManifestEntry objects ready for the shell.
 */
// Module-level record of registered remotes (moduleId -> entry URL) so
// resetRemote() can tear down and re-register a container without callers
// having to thread the entry URL through.
const registeredEntries = new Map<string, string>();

// =============================================================================
// LOCAL APP OVERRIDES (DEV HOOKS)
// =============================================================================

// Local descriptor loaders keyed by APP id (not moduleId). Consulted at
// load() CALL TIME rather than at mapping time, so a local registration made
// AFTER the manifest was mapped still wins, and a manifest-driven
// re-registration can never clobber it. Exposure to embedders is dev-gated
// via window.__rrShellDev (see lib/devMode.ts); the functions themselves are
// ungated so in-tree dev tooling can import them directly.
const localOverrides = new Map<string, () => Promise<AppDescriptor>>();

// Synthetic manifest entries for local apps the server has never heard of:
// a purely CLIENT-SIDE presence, so an in-browser-compiled app previews with
// ZERO server round trips. Shell merges these into its app list via the
// listener below.
const localAppMetas = new Map<string, { id: string; moduleId: string; name: string }>();
let localAppsListener: (() => void) | null = null;

/**
 * Registers (or clears, with null) the local-apps change listener. Shell
 * installs it so synthetic local entries re-render the app list.
 *
 * @param fn - Change callback, or null on unmount.
 */
export function setLocalAppsListener(fn: (() => void) | null): void {
	localAppsListener = fn;
}

/**
 * The synthetic manifest entries for locally registered apps, mapped to
 * runtime AppManifestEntry objects whose load() resolves the local
 * override. Shell appends the ones its list does not already contain.
 */
export function getLocalAppEntries(): AppManifestEntry[] {
	return [...localAppMetas.values()].map((meta) => ({
		id: meta.id,
		moduleId: meta.moduleId,
		name: meta.name,
		description: 'Local development app',
		authenticated: false,
		public: false,
		load: () => {
			const local = localOverrides.get(meta.id);
			if (!local) return Promise.reject(new Error(`Local app "${meta.id}" has no registered loader`));
			return local();
		},
	}));
}

/**
 * Registers a local (non-Module-Federation) descriptor loader for an app.
 *
 * For an app the manifest already knows, this overrides HOW its descriptor
 * is produced. For a BRAND-NEW app, pass `meta` — a synthetic manifest
 * entry is created client-side so the app is resolvable at all (no server
 * involvement: the preview loop is compile-in-browser + inject). Call
 * invalidateAppDescriptor() afterwards to evict any cached descriptor; the
 * loader should return a FRESH descriptor object per call — new component
 * identities are what force React to fully remount the app.
 *
 * @param id - The app id (e.g. "rocketride.hello").
 * @param load - Loader producing the app's AppDescriptor.
 * @param meta - Display facts for the synthetic entry (new apps only).
 */
export function registerLocalApp(id: string, load: () => Promise<AppDescriptor>, meta?: { name?: string; moduleId?: string }): void {
	localOverrides.set(id, load);
	if (meta) {
		localAppMetas.set(id, {
			id,
			moduleId: meta.moduleId || id.replace(/[^a-zA-Z0-9_$]/g, '_'),
			name: meta.name || id,
		});
		localAppsListener?.();
	}
	console.log(`[appLoader] Local override registered for "${id}"`);
}

/**
 * Removes a local descriptor loader (and its synthetic entry, if any),
 * returning the app to its Module Federation entry. Call
 * invalidateAppDescriptor() afterwards to drop the locally produced
 * descriptor from the cache.
 *
 * @param id - The app id whose local override should be removed.
 */
export function unregisterLocalApp(id: string): void {
	const hadOverride = localOverrides.delete(id);
	if (localAppMetas.delete(id)) localAppsListener?.();
	if (hadOverride) {
		console.log(`[appLoader] Local override removed for "${id}"`);
	}
}

/**
 * Registers a dev-server-hosted MF remote as a local app: the embedding App
 * Builder panel knows its rsbuild dev server's address and hands it straight
 * to this shell (no server round trip, no dev-overlay dependency — the shell
 * can belong to ANY environment). The remote is force-registered so a
 * repointed entry URL replaces a stale container, and the synthetic manifest
 * entry makes brand-new apps resolvable.
 *
 * @param appId - The app id ("org.myapp").
 * @param moduleId - The MF container name ("org_myapp").
 * @param name - Display name for the synthetic manifest entry.
 * @param entry - The dev server's remoteEntry.js URL.
 */
export function registerDevRemote(appId: string, moduleId: string, name: string, entry: string): void {
	registerRemotes([{ name: moduleId, entry }], { force: true });
	registeredEntries.set(moduleId, entry);
	registerLocalApp(
		appId,
		() => (loadRemote(`${moduleId}/AppDescriptor`) as Promise<{ default: AppDescriptor }>).then((m) => m.default),
		{ name, moduleId },
	);
	invalidateAppDescriptor(appId);
}

/**
 * Returns the entry URL currently registered for an MF remote, or undefined
 * when the module has never been registered. Used by Shell to detect apps
 * whose entry URL changed (dev overlay repoint, new published version) and
 * need force re-registration + descriptor invalidation.
 *
 * @param moduleId - The MF container name (AppManifestEntry.moduleId).
 */
export function getRegisteredEntry(moduleId: string): string | undefined {
	return registeredEntries.get(moduleId);
}

// =============================================================================
// DESCRIPTOR INVALIDATION BRIDGE
// =============================================================================

// WorkspaceContext registers its invalidateDescriptor callback here so
// non-React code (Shell's entry-change reconciliation, __rrShellDev) can
// evict cached descriptors without holding a React context reference. NOT
// dev-gated: manifest-driven entry changes must invalidate in production too.
let descriptorInvalidator: ((appId: string) => void) | null = null;

/**
 * Registers (or clears, with null) the descriptor invalidation callback.
 * Called by WorkspaceProvider on mount/unmount.
 *
 * @param fn - Callback evicting one app's cached descriptor, or null.
 */
export function setDescriptorInvalidator(fn: ((appId: string) => void) | null): void {
	descriptorInvalidator = fn;
}

/**
 * Evicts an app's cached descriptor (and reloads it if the app is active)
 * via the registered WorkspaceContext callback. Safe to call before the
 * provider mounts — the eviction is simply skipped (nothing is cached yet).
 *
 * @param appId - The app whose descriptor should be evicted.
 */
export function invalidateAppDescriptor(appId: string): void {
	if (descriptorInvalidator) {
		descriptorInvalidator(appId);
	} else {
		console.warn(`[appLoader] invalidateAppDescriptor("${appId}") before WorkspaceProvider mounted — nothing to evict`);
	}
}

/**
 * Tear down a remote's (possibly half-initialized) MF container and register
 * it fresh. Used by the app-load retry path: a failed first load leaves the
 * container partially executed, and re-loading the CACHED container throws
 * TDZ errors ("Cannot access 'x' before initialization") instead of retrying
 * the real fetch. Safe for failed containers — nothing has successfully
 * consumed them, unlike force-re-registering a live, loaded remote.
 *
 * @param moduleId - The MF container name (AppManifestEntry.moduleId).
 */
export function resetRemote(moduleId: string): void {
	const entry = registeredEntries.get(moduleId);
	if (!entry) return;
	registerRemotes([{ name: moduleId, entry }], { force: true });
}

export function registerAndMapApps(serverApps: ServerAppEntry[]): AppManifestEntry[] {
	// Drop entries missing a remoteEntry URL — the server may include
	// apps that have no built UI yet (e.g. server-only nodes).
	// Without this guard, MF's normalizeRemote crashes on undefined.
	const validApps = serverApps.filter((a) => a.entry);

	// Register all MF remotes so loadRemote() can resolve them.
	// force: true overwrites any previously registered remotes (e.g. from
	// the pre-auth probe) with the post-auth set.
	registerRemotes(
		validApps.map((a) => ({ name: a.moduleId, entry: a.entry })),
		{ force: true },
	);

	// Record the registered URLs so resetRemote() can rebuild a container.
	for (const a of validApps) registeredEntries.set(a.moduleId, a.entry);

	// Map server entries to runtime AppManifestEntry objects with lazy loaders
	return validApps.map((a) => ({
		id:            a.id,
		moduleId:      a.moduleId,
		name:          a.name,
		description:   a.description,
		icon:          a.icon,
		categories:    a.categories,
		// Settings contribution — validated structurally by the registry builder,
		// so legacy array-shaped `settings` rows from an un-reseeded server are
		// simply ignored rather than crashing the shell.
		configuration: a.configuration as AppConfiguration | undefined,
		authenticated: a.authenticated,
		showHeader:    a.showHeader,
		showStatusBar: a.showStatusBar,
		public:        a.public,
		load: () => {
			// Local override wins over the MF remote — checked per CALL so a
			// dev registration made after mapping still takes effect (and its
			// removal restores the remote) without re-mapping the manifest.
			const local = localOverrides.get(a.id);
			if (local) return local();
			return (loadRemote(`${a.moduleId}/AppDescriptor`) as Promise<{ default: AppDescriptor }>)
				.then((m) => m.default);
		},
	}));
}
