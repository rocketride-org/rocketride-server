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
import type { AppManifestEntry, AppDescriptor, AppConfiguration } from '../components/workspace/types';
// Session version overrides — read-only here (registration-time entry
// substitution); the write side lives in versionOverride.ts. The two
// modules reference each other strictly through function calls at runtime,
// so the import cycle carries no module-evaluation (TDZ) risk.
import { getAppVersionOverrides, versionedEntryUrl } from './versionOverride';

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
	/** Registry version number the entry resolves to (the scope-walk winner). */
	registryVersion?: number;
	/** Whether the app UI requires auth to render. */
	authenticated?: boolean;
	/** Whether the app is visible to unauthenticated users. */
	public?: boolean;
	/** Resolved app version (semver) — built-in package version, marketplace active version, or deployed pin. */
	version?: string;
	// (entry / dev / devEntries are RETIRED: the server carries no dev rows —
	// dev previews are LOCAL-FIRST, registered client-side in the preview
	// page. Published versions resolve by registryVersion alone.)
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

// MF containers whose remote has successfully LOADED this document. A loaded
// container is committed to its version (identity is the name — repointing a
// loaded container corrupts its shared getters), so the version selector
// consults this to decide repoint-in-place vs full reload.
const loadedModules = new Set<string>();

// MF containers with a descriptor load currently IN FLIGHT. A container is
// committed to its entry from the moment its load STARTS, not when it
// resolves: forced re-registration drops the runtime's cached promise but
// does NOT cancel the running operation, so replacing the entry mid-load
// races two initializations of one container name. The dev takeover treats
// pending like loaded. A Set suffices — loadDescriptor dedups concurrent
// loads per app, so at most one load per container is in flight.
const pendingModules = new Set<string>();

/**
 * Whether an MF container's remote has successfully loaded this document.
 *
 * @param moduleId - The MF container name.
 */
export function isRemoteLoaded(moduleId: string): boolean {
	return loadedModules.has(moduleId);
}

/**
 * Force re-register an MF container at a new entry URL (version override
 * apply/boot). Refuses dev-owned containers — the live dev build always
 * wins — AND containers that have already LOADED this document: repointing a
 * loaded container corrupts its consume-shared getters (identity is the name;
 * MF commits a container to its version once its remote resolves). The
 * precondition is ENFORCED here rather than trusted to callers — a refusal
 * returns false so the caller can fall back to a full page reload.
 *
 * @param moduleId - The MF container name.
 * @param entry - The new remoteEntry.js URL.
 * @returns True when the container was repointed; false when refused
 *          (dev-owned, or already loaded — reload the page instead).
 */
export function repointRemote(moduleId: string, entry: string): boolean {
	if (devRemoteModules.has(moduleId)) return false;
	// A loaded container is committed to its version for the document's
	// lifetime — force-repointing it corrupts its shared getters.
	if (loadedModules.has(moduleId)) return false;
	registerRemotes([{ name: moduleId, entry }], { force: true });
	registeredEntries.set(moduleId, entry);
	return true;
}

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

/**
 * Display + contribution facts a dev registration may carry. Everything is
 * optional and append-only: in dev, the WORKSPACE manifest is the truth, so
 * whatever the registration provides IS the app's row while the
 * registration lives (Shell's replace-merge). Both dev flavours feed this
 * client-side — the web App Builder via rrdev:registerRemote's manifest
 * payload, top-level dev tabs via URL-convention self-registration — so
 * there is no server-side whitelist to mirror.
 */
export interface LocalAppMeta {
	/** Display name. */
	name?: string;
	/** MF container name (derived from the id when omitted). */
	moduleId?: string;
	/** Listing description. */
	description?: string;
	/** The package's semver. */
	version?: string;
	/**
	 * Icon as a data: URI (web builder — page-local, no serving route) or a
	 * path under the app's dev prefix (/apps/<id>/dev/..., proxy-served).
	 */
	icon?: string;
	/** The manifest's contributes.configuration (settings schema). */
	configuration?: AppManifestEntry['configuration'];
	/** Manifest categories. */
	categories?: string[];
}

// Synthetic manifest entries for local apps the server has never heard of:
// a purely CLIENT-SIDE presence, so an in-browser-compiled app previews with
// ZERO server round trips. Shell merges these into its app list via the
// listener below — and field-overlays them onto server rows for ids the
// server DOES know (dev metadata beats the registry while registered).
const localAppMetas = new Map<string, { id: string; moduleId: string; name: string } & Omit<LocalAppMeta, 'name' | 'moduleId'>>();
let localAppsListener: (() => void) | null = null;

// MF containers currently owned by a DEV registration. Manifest-driven
// (re)registration must never clobber these: the identity merge and the
// entry-change reconciliation would repoint the container at the server's
// (older) published bundle mid-session — the dev preview then loads THAT
// and dies on platform mismatch (RUNTIME-012).
//
// PAGE-LIFETIME ONLY, never persisted. Ownership used to be persisted in
// sessionStorage on a per-browser-tab assumption, but a VS Code window is
// ONE browsing context: every App Builder preview iframe against the same
// engine origin shares a single sessionStorage (which also survives
// workspace switches), so ownership accumulated across every app ever
// designed and stranded them all as mapped-but-unregistered (RUNTIME-004
// on launch). The boot-time "keep the container clean for the dev entry"
// job is DERIVED instead: a dev-preview page skips the manifest
// registration of its session-locked app (see registerAndMapApps), so the
// injection is the container's first registration without any stored state.
const devRemoteModules = new Set<string>();

/**
 * Whether an MF container is currently dev-owned (see devRemoteModules).
 *
 * @param moduleId - The MF container name.
 */
export function isDevRemote(moduleId: string): boolean {
	return devRemoteModules.has(moduleId);
}

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
 * How long an embedded dev preview holds its locked app for the embedder's
 * dev-remote registration, measured from page load. App Builder mounts the
 * preview only once its dev server is serving and injects on shell:devReady,
 * so a healthy registration lands within a second or two — one that has not
 * arrived by this deadline is not coming (an app id the embedder does not
 * register, a dead dev server). Ending the hold lets the real outcome show
 * ("App not found", the load error, or the published fallback) instead of a
 * splash that never resolves. A registration that does arrive late still
 * self-corrects: the injection invalidates and reloads the app.
 */
export const DEV_REMOTE_TIMEOUT_MS = 30_000;

/**
 * Milliseconds left in this page's dev-preview hold: 0 once the deadline has
 * passed, and always 0 on a page that is not an embedded dev preview.
 */
export function devPreviewHoldRemainingMs(): number {
	if (!isDevPreviewPage()) return 0;
	return Math.max(0, DEV_REMOTE_TIMEOUT_MS - performance.now());
}

/**
 * Whether an app is an EMBEDDED DEV PREVIEW's locked app still waiting for
 * its dev registration. The injection can only arrive after the shell has
 * booted and announced itself — during that window the deep-linked app
 * either isn't in the manifest (new apps) or fails to load (dead published
 * entry), and showing an error would be a flash that the injection's
 * invalidate-and-retry immediately self-corrects. The layout holds the
 * loading state instead while this is true — but only for the app the page
 * is locked to, and only until DEV_REMOTE_TIMEOUT_MS: an unbounded hold
 * hides every failure behind the splash.
 *
 * @param appId - The app whose load state is being rendered.
 */
export function isDevPreviewPending(appId: string): boolean {
	// Once locally registered, real load states (success or error) apply.
	if (localOverrides.has(appId)) return false;
	const lockedAppId = previewLockedAppId();
	return !!lockedAppId && appId === lockedAppId && devPreviewHoldRemainingMs() > 0;
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
		description: meta.description || 'Local development app',
		authenticated: false,
		public: false,
		// step: dev means "I'm working on it, show me everything" — the
		// settings registry and desktop surfaces gate on onDesktop, and
		// appStatus 'dev' makes billing gating moot while under development
		onDesktop: true,
		appStatus: 'dev',
		dev: true,
		...(meta.version !== undefined ? { version: meta.version } : {}),
		...(meta.icon !== undefined ? { icon: meta.icon } : {}),
		...(meta.configuration !== undefined ? { configuration: meta.configuration } : {}),
		...(meta.categories !== undefined ? { categories: meta.categories } : {}),
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
 * @param meta - Workspace-manifest facts for the entry: for a brand-new app
 *   they ARE its manifest presence; for a server-known app they OVERLAY the
 *   registry row while the registration lives (dev = files are the truth).
 */
export function registerLocalApp(id: string, load: () => Promise<AppDescriptor>, meta?: LocalAppMeta): void {
	localOverrides.set(id, load);
	if (meta) {
		localAppMetas.set(id, {
			...meta,
			id,
			moduleId: meta.moduleId || id.replace(/[^a-zA-Z0-9_$]/g, '_'),
			name: meta.name || id,
		});
		localAppsListener?.();
	}
	// Release any descriptor loads holding for this app's dev registration:
	// a local registration satisfies the embedded preview's wait exactly like
	// a dev-remote one (the web App Builder injects linked descriptors, never
	// an MF remote, so the dev-remote wait must not outlive it).
	devRegisteredApps.add(id);
	devFailedApps.delete(id);
	for (const waiter of devRemoteWaiters.get(id) ?? []) waiter.resolve();
	devRemoteWaiters.delete(id);
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
	const meta = localAppMetas.get(id);
	if (meta) devRemoteModules.delete(meta.moduleId);
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
 * @param meta - Workspace-manifest metadata (name, icon, configuration...) —
 *               in dev the workspace is the truth, not the server registry.
 */
export function registerDevRemote(appId: string, moduleId: string, name: string, entry: string, meta?: LocalAppMeta): void {
	// The wrong-id signal: an embedded preview receives ONE registration, for
	// the app its URL is locked to. A registration for any other id means the
	// two disagree, and the locked app will never register — say so instead
	// of letting the preview run out its hold in silence.
	const lockedAppId = isDevPreviewPage() ? previewLockedAppId() : '';
	if (lockedAppId && appId !== lockedAppId) {
		console.warn(`[appLoader] App Builder delivered a dev build for "${appId}", but this preview is for "${lockedAppId}" — check appManifest.id in the app's package.json`);
	}


	// Injection for a container the manifest registered AND that is LOADED or
	// mid-load this document: such a container is committed to its entry
	// (repointing corrupts its consume-shared getters; a forced registration
	// does not cancel an in-flight load, it races it), so only a reboot can
	// hand the dev entry a clean container. Normally unreachable — the
	// dev-preview boot skips the locked app's manifest registration and the
	// hold orders the registration before the first load on both flavors
	// (framed push, top-level self-registration) — this covers a
	// lock/injection mismatch and the late-registration-after-fallback case.
	if (registeredEntries.has(moduleId) && !devRemoteModules.has(moduleId) && (loadedModules.has(moduleId) || pendingModules.has(moduleId))) {
		let reboot = false;
		try {
			// One-shot per session: after the reboot the dev-preview hold
			// orders the registration BEFORE the app's first load, so the
			// takeover cannot legitimately recur — a second hit means an
			// unheld page (console use, missing lock) and force-registers.
			const key = `rr:devTakeover:${moduleId}`;
			if (!sessionStorage.getItem(key)) {
				sessionStorage.setItem(key, '1');
				reboot = true;
			}
		} catch { /* storage unavailable — cannot bound a reload loop, so never reload */ }
		if (reboot) {
			console.log(`[appLoader] dev registration for active container "${moduleId}" — rebooting for a clean container`);
			window.location.reload();
			return;
		}
		console.error(`[appLoader] dev takeover of active container "${moduleId}" — force-registering in place; its shared getters may be stale`);
	}

	devRemoteModules.add(moduleId);
	registerRemotes([{ name: moduleId, entry }], { force: true });
	registeredEntries.set(moduleId, entry);
	registerLocalApp(
		appId,
		() => (loadRemote(`${moduleId}/AppDescriptor`) as Promise<{ default: AppDescriptor }>)
			.then((m) => m.default)
			.catch((err) => {
				// Full failure forensics: the error itself (message + stack, not
				// the {} an Error JSON-stringifies to) plus the share scope the
				// container negotiated against — key, version, loaded state.
				console.error(`[appLoader] dev remote "${moduleId}" failed to load from ${entry}: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
				dumpShareScope();
				throw err;
			}),
		// step: the posted workspace manifest (when present) IS the app's
		// metadata in dev — name/moduleId remain explicit for older senders
		{ ...meta, name: meta?.name || name, moduleId },
	);
	// registerLocalApp above released the dev-remote wait for this app.
	invalidateAppDescriptor(appId);
}

// =============================================================================
// DEV-REMOTE WAIT — embedded previews hold the locked app's first load
// =============================================================================

/** App ids whose dev remote registration has arrived this page. */
const devRegisteredApps = new Set<string>();
/**
 * Pending load releases per app id — resolved by registerDevRemote, rejected
 * by failDevRemoteWait (URL-convention self-registration found no dev app).
 */
const devRemoteWaiters = new Map<string, Array<{ resolve: () => void; reject: (err: Error) => void }>>();
/**
 * App ids whose dev registration source has definitively failed (appId →
 * reason). Makes failDevRemoteWait sticky for waits that START after the
 * failure; cleared by a late real registration.
 */
const devFailedApps = new Map<string, string>();
/**
 * Manifest entries the dev-preview boot skipped for the session-locked app
 * (appId → container + URL), stashed so the dev-remote wait can fall back
 * to the published bundle when no injection ever arrives.
 */
const skippedManifestEntries = new Map<string, { moduleId: string; url: string }>();

/**
 * Last-resort registration of a dev-skipped app from its stashed manifest
 * entry. The boot skip assumes the embedder's injection will arrive; when
 * it never does (dev server dead, lock mismatch), registering the published
 * bundle beats a permanently dead app. No-op once a real dev registration
 * has arrived, or when nothing was skipped.
 *
 * @param appId - The preview-locked app id whose dev-remote wait timed out.
 * @returns True when the manifest fallback was registered.
 */
export function fallbackSkippedRemote(appId: string): boolean {
	if (devRegisteredApps.has(appId)) return false;
	const stash = skippedManifestEntries.get(appId);
	if (!stash) return false;
	registerRemotes([{ name: stash.moduleId, entry: stash.url }], { force: true });
	registeredEntries.set(stash.moduleId, stash.url);
	console.warn(`[appLoader] dev remote for "${appId}" never registered — falling back to the published bundle at ${stash.url}`);
	return true;
}

/**
 * Whether this page is a dev preview (`rrdev=1`, or the session marker that
 * survives the OAuth redirect stripping the query string). Such a page
 * ALWAYS receives a dev registration for its locked app — a FRAMED page via
 * rrdev:registerRemote posted by its embedder (the App Builder panel), a
 * TOP-LEVEL page (F5 external-browser session on the dev-proxy origin) via
 * devMode's URL-convention self-registration — so loading that app before
 * the registration arrives can only fail. Self-registration settles the
 * hold on BOTH outcomes: registerDevRemote on success, failDevRemoteWait
 * when the conventional prefix serves no dev app (stale rrdev URL on a
 * non-proxy origin), which drops the hold into its published fallback.
 */
export function isDevPreviewPage(): boolean {
	try {
		if (new URLSearchParams(window.location.search).get('rrdev') === '1') return true;
		return sessionStorage.getItem('rr:dev') === '1';
	} catch {
		return false;
	}
}

/**
 * The app id this page is session-locked to (`?appid=` / `?appId=`), or ''.
 * The value identifies WHICH app's first load the dev-preview hold applies
 * to. The URL wins; the sessionStorage copy ('rr:devAppId', persisted by the
 * flavor picker beside 'rr:dev') covers the OAuth redirect, which strips the
 * query string on its way back to the bare origin.
 */
export function previewLockedAppId(): string {
	try {
		const params = new URLSearchParams(window.location.search);
		const fromUrl = params.get('appId') || params.get('appid');
		if (fromUrl) return fromUrl;
		return sessionStorage.getItem('rr:devAppId') || '';
	} catch {
		return '';
	}
}

/**
 * Resolves once the app's dev remote registration has arrived (immediately
 * when it already has). Callers gate the preview-locked app's descriptor
 * load on this so the load cannot race the app dev server's startup
 * (pnpm install + rsbuild take seconds; the shell boots in milliseconds).
 */
export function waitForDevRemote(appId: string): Promise<void> {
	if (devRegisteredApps.has(appId)) return Promise.resolve();
	const failed = devFailedApps.get(appId);
	if (failed) return Promise.reject(new Error(failed));
	return new Promise((resolve, reject) => {
		const list = devRemoteWaiters.get(appId) ?? [];
		list.push({ resolve, reject });
		devRemoteWaiters.set(appId, list);
	});
}

/**
 * Fails the app's dev-remote wait — called when the registration source has
 * DEFINITIVELY failed (a top-level dev page's URL-convention
 * self-registration found no dev app at the conventional prefix), so the
 * hold fails into its fallback immediately instead of riding out the full
 * timeout. Pending waits reject now; later waits reject on arrival. A real
 * registration arriving afterwards clears the failure (late recovery).
 *
 * @param appId - The preview-locked app id whose wait should fail.
 * @param reason - Human-readable cause, surfaced by the load error path.
 */
export function failDevRemoteWait(appId: string, reason: string): void {
	if (devRegisteredApps.has(appId)) return;
	devFailedApps.set(appId, reason);
	const waiters = devRemoteWaiters.get(appId);
	if (!waiters?.length) return;
	devRemoteWaiters.delete(appId);
	for (const waiter of waiters) waiter.reject(new Error(reason));
}

/**
 * Logs the MF share scope's contents — one line per shared module version
 * with its loaded/eager state. The first thing to read when a dev remote's
 * share negotiation goes sideways.
 */
function dumpShareScope(): void {
	try {
		// EVERY runtime instance: a split brain (the plugin's host instance vs
		// a second one spawned by runtime-API calls) is itself a diagnosis —
		// containers negotiating on an instance without the host's shared
		// config see an empty scope and die with RUNTIME-012.
		const host = (globalThis as unknown as Record<string, unknown>).__FEDERATION__ as { __INSTANCES__?: Array<{ name?: string; shareScopeMap?: Record<string, Record<string, Record<string, { loaded?: boolean; eager?: boolean; from?: string }>>> }> } | undefined;
		const instances = host?.__INSTANCES__ ?? [];
		console.warn(`[appLoader] federation instances: ${instances.length} [${instances.map((i) => i.name ?? '?').join(', ')}]`);
		instances.forEach((instance, index) => {
			const scope = instance.shareScopeMap?.default;
			if (!scope) {
				console.warn(`[appLoader] instance[${index}] ${instance.name ?? '?'}: no default share scope`);
				return;
			}
			for (const [key, versions] of Object.entries(scope)) {
				for (const [version, meta] of Object.entries(versions)) {
					console.warn(`[appLoader] instance[${index}] ${instance.name ?? '?'} scope: ${key}@${version} loaded=${meta.loaded ?? false} eager=${meta.eager ?? false} from=${meta.from ?? '?'}`);
				}
			}
		});
	} catch (err) {
		console.warn(`[appLoader] share scope dump failed: ${err instanceof Error ? err.message : String(err)}`);
	}
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

// (sessionNonce is RETIRED: dev previews are LOCAL-FIRST — each preview
// page loads through ITS editor's dev-server proxy, so per-editor
// affinity is a property of the page's ORIGIN, not a nonce. Two editors
// dev-serving one app each preview their own build by construction.)

/**
 * The COMPLETE load-URL resolution for one server app entry.
 *
 * The wire carries version NUMBERS, never URL strings: the stable
 * versioned URL constructs from the tab's session override or the
 * manifest's resolved default. Session version overrides (desktop version
 * selector / `?version=` deep link) substitute the default SYNCHRONOUSLY
 * at registration time — the boot path can then never race a load with an
 * async repoint.
 *
 * Precedence: explicit version override > published default. Dev previews
 * are LOCAL-FIRST and never ride the server manifest — a dev registration
 * (push or URL convention) owns its container via devRemoteModules, which
 * this resolution path never touches.
 *
 * @param a - The server app entry.
 * @returns The load URL, or null when nothing resolves (no built UI yet).
 */
export function resolveServerEntry(a: ServerAppEntry): string | null {
	const o = getAppVersionOverrides()[a.id];
	if (o) return versionedEntryUrl(a.id, o.version);
	return typeof a.registryVersion === 'number' ? versionedEntryUrl(a.id, a.registryVersion) : null;
}

export function registerAndMapApps(serverApps: ServerAppEntry[]): AppManifestEntry[] {
	const overrides = getAppVersionOverrides();
	/** The entry's effective version override (chip + resolution agree). */
	const overrideOf = (a: ServerAppEntry): { version: number; appVersion?: string } | null => {
		return overrides[a.id] ?? null;
	};

	// Resolve ONCE per entry, then reuse: resolveServerEntry reads
	// sessionStorage and JSON.parses the override map on every call, and this
	// runs for every manifest registration during boot.
	//
	// Entries that resolve to no load URL are dropped here — the server may
	// include apps that have no built UI yet (e.g. server-only nodes).
	// Without that guard, MF's normalizeRemote crashes on undefined.
	const resolved: Array<{ app: ServerAppEntry; url: string }> = [];
	for (const a of serverApps) {
		const url = resolveServerEntry(a);
		if (url !== null) resolved.push({ app: a, url });
	}

	// Register all MF remotes so loadRemote() can resolve them.
	// force: true overwrites any previously registered remotes (e.g. from
	// the pre-auth probe) with the post-auth set. Dev-owned containers are
	// NEVER (re)registered from the manifest — the dev entry stays live.
	//
	// A dev-preview page additionally skips its SESSION-LOCKED app: the
	// embedder's injection must be that container's FIRST registration
	// (force-overriding an initialized container corrupts its consume-shared
	// getters). Derived fresh per call from the URL/session lock — never
	// persisted — so the skip cannot leak to other apps or outlive the
	// preview. The skipped entry is stashed for the dev-remote wait's
	// manifest fallback (fallbackSkippedRemote).
	const lockedAppId = isDevPreviewPage() ? previewLockedAppId() : '';
	const registrable = resolved.filter(({ app }) => !devRemoteModules.has(app.moduleId) && app.id !== lockedAppId);
	for (const { app, url } of resolved) {
		if (app.id === lockedAppId && !devRemoteModules.has(app.moduleId)) {
			skippedManifestEntries.set(app.id, { moduleId: app.moduleId, url });
		}
	}
	registerRemotes(
		registrable.map(({ app, url }) => ({ name: app.moduleId, entry: url })),
		{ force: true },
	);

	// Record the registered URLs so resetRemote() can rebuild a container.
	for (const { app, url } of registrable) registeredEntries.set(app.moduleId, url);

	// Map server entries to runtime AppManifestEntry objects with lazy loaders
	return resolved.map(({ app: a }) => ({
		id:            a.id,
		moduleId:      a.moduleId,
		name:          a.name,
		description:   a.description,
		icon:          a.icon,
		categories:    a.categories,
		// Settings contribution — validated structurally by the registry builder.
		configuration: a.configuration as AppConfiguration | undefined,
		authenticated: a.authenticated,
		public:        a.public,
		// Version chip data — an applied override wins the display
		version:       overrideOf(a)?.appVersion ?? a.version,
		registryVersion: overrideOf(a)?.version ?? a.registryVersion,
		load: () => {
			// Local override wins over the MF remote — checked per CALL so a
			// dev registration made after mapping still takes effect (and its
			// removal restores the remote) without re-mapping the manifest.
			const local = localOverrides.get(a.id);
			if (local) return local();
			// Pending marks the container committed for the WHOLE load — the
			// dev takeover must not force-register it mid-flight.
			pendingModules.add(a.moduleId);
			return (loadRemote(`${a.moduleId}/AppDescriptor`) as Promise<{ default: AppDescriptor }>)
				.then((m) => {
					// A resolved remote commits this container to its version
					// for the document's lifetime (see isRemoteLoaded).
					loadedModules.add(a.moduleId);
					return m.default;
				})
				.finally(() => pendingModules.delete(a.moduleId));
		},
	}));
}
