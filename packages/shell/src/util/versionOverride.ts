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
 * App version overrides — a pin that lives in the ADDRESS BAR.
 *
 * A user picking a specific app version (tile drop list, or a
 * `?appid=X&version=7` deep link) pins that app to that registry version.
 * The pin is held in the URL and nowhere else, which is a deliberate change
 * from the sessionStorage map this used to be.
 *
 * WHY THE URL. A pin in sessionStorage is state with no address: invisible,
 * unshareable, surviving every reload and dying only with the tab. Bytes are
 * immutable per version, so a pinned app keeps working perfectly — it is
 * simply the app as it was on the day it was pinned, and no error, no failed
 * request and no amount of rebuilding says otherwise. Days have gone into
 * "my change will not show" that were one forgotten pin. In the URL the pin
 * can be seen, copied, sent to someone else, and left behind by navigating —
 * which is what everyone already assumes a temporary choice does.
 *
 * Resolution order (top wins): URL pin → dev overlay → the server's
 * scope-walk default in the manifest entry.
 *
 * Entry URLs are CONSTRUCTED, never minted: every version serves from the
 * stable immutable `/apps/<appId>/v<N>/remoteEntry.js` route, entitlement
 * enforced by the server per request — switching needs zero round trips
 * (the retired `entry` verb's signed URLs are gone). The override is
 * applied to the MF container either synchronously at registration time
 * (registerAndMapApps constructs and substitutes the URL — the boot path,
 * race-free) or via applyAppVersionOverride() when the user picks a
 * version mid-session (repoint when the container has not loaded yet;
 * reload otherwise — a loaded container can never be repointed, see the
 * MF one-document-one-version rule).
 */

import { repointRemote, isRemoteLoaded, invalidateAppDescriptor, isDevRemote } from './appLoader';

// =============================================================================
// STORAGE — the query string
// =============================================================================

/** The app a pin names. Already the deep-link parameter for "open this app". */
const APP_PARAM = 'appid';
/** The registry version it is pinned to. Ints only. */
const VERSION_PARAM = 'version';
/** The artifact's semver, carried only so the chip can print it. */
const APPVER_PARAM = 'appver';

/**
 * Read the query string of the document.
 *
 * @returns The params, or an empty set when there is no document (SSR/tests).
 */
function params(): URLSearchParams {
	try {
		return new URLSearchParams(window.location.search);
	} catch {
		return new URLSearchParams();
	}
}

/**
 * Rewrite the query string in place, without navigating.
 *
 * `replaceState` rather than `pushState`: a pin is a property of what you are
 * looking at, not a place you travelled to, so Back should leave the app —
 * not step through the versions you tried.
 *
 * @param next - The params to put in the address bar.
 */
function writeParams(next: URLSearchParams): void {
	try {
		const query = next.toString();
		const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
		window.history.replaceState(window.history.state, '', url);
	} catch { /* no history API — the pin simply does not stick */ }
}

/**
 * The stable serving URL of one registry version's entry.
 *
 * Relative — the shell document is served from the same origin, exactly
 * like the manifest's own entries. Immutable bytes live behind it; the
 * server enforces entitlement on every request, so constructing a URL the
 * caller is not entitled to yields a 404 at load, never a leak.
 *
 * @param appId - The app id.
 * @param version - The registry version number (ints only).
 * @returns The versioned remoteEntry URL.
 */
export function versionedEntryUrl(appId: string, version: number): string {
	return `/apps/${appId}/v${version}/remoteEntry.js`;
}

/**
 * One app's version pin.
 *
 * `version` is the registry version number (a `?version=` semver deep link
 * is resolved to its registry int before it lands here). The record holds
 * NUMBERS only — the load URL is constructed from `version` at use
 * (versionedEntryUrl), exactly as manifest defaults are constructed from
 * `registryVersion`; no URL strings are ever stored.
 */
export interface AppVersionOverride {
	/** Registry version number — THE wire version identity (ints only). */
	version: number;
	/** The resolved artifact semver — for chip display. */
	appVersion?: string;
}

/**
 * Reads the pins in the address bar.
 *
 * ONE app at a time, by construction: the URL names an app and a version. The
 * map shape is kept because every caller reads it by app id, and because a
 * second pinning scheme could be added here without touching them.
 *
 * REGISTRY INTS ONLY — a value with any trailing non-digit (`?version=7abc`)
 * is rejected outright rather than silently pinned to 7 by prefix parsing.
 *
 * @returns App id → pin; empty object when nothing is pinned.
 */
export function getAppVersionOverrides(): Record<string, AppVersionOverride> {
	const search = params();
	const appId = search.get('appId') || search.get(APP_PARAM) || '';
	const raw = search.get(VERSION_PARAM) ?? '';
	if (!appId || !/^\d+$/.test(raw)) return {};
	const version = Number.parseInt(raw, 10);
	if (!(version > 0)) return {};
	const appVersion = search.get(APPVER_PARAM) || undefined;
	return { [appId]: appVersion ? { version, appVersion } : { version } };
}

/**
 * Reads one app's session version override.
 *
 * @param appId - The app id.
 * @returns The override, or null when the app has none.
 */
export function getAppVersionOverride(appId: string): AppVersionOverride | null {
	return getAppVersionOverrides()[appId] ?? null;
}

/**
 * Pins one app to one version, by putting it in the address bar.
 *
 * The app parameter is written too: a version without the app it belongs to
 * means nothing, and the pair is exactly the existing deep-link shape, so a
 * pinned URL opens the same thing when it is pasted somewhere else.
 *
 * @param appId - The app id.
 * @param override - The version to pin to.
 */
export function setAppVersionOverride(appId: string, override: AppVersionOverride): void {
	const next = params();
	next.delete('appId');           // the accepted alternate spelling, so one wins
	next.set(APP_PARAM, appId);
	next.set(VERSION_PARAM, String(override.version));
	if (override.appVersion) next.set(APPVER_PARAM, override.appVersion);
	else next.delete(APPVER_PARAM);
	writeParams(next);
}

/**
 * Unpins one app: the version leaves the address bar.
 *
 * The app parameter STAYS — it is also "which app is open", and dropping it
 * would navigate away from the thing being unpinned.
 *
 * @param appId - The app id. Ignored when a different app is pinned.
 */
export function clearAppVersionOverride(appId: string): void {
	if (!getAppVersionOverrides()[appId]) return;
	const next = params();
	next.delete(VERSION_PARAM);
	next.delete(APPVER_PARAM);
	writeParams(next);
}

// =============================================================================
// APPLICATION — repoint now, or reload when the container is committed
// =============================================================================

/**
 * Applies (or clears, with null) a version override to a live shell.
 *
 * The caller passes version NUMBERS only; the load URL is constructed
 * here (versionedEntryUrl). This function handles the MF mechanics:
 *
 * - Container never loaded this session → force re-register at the
 *   constructed URL + evict the cached descriptor. The next launch loads
 *   the chosen version. Returns 'ready' — the caller may switch
 *   immediately.
 * - Container already loaded (or clearing an applied override) → a loaded
 *   MF container can never be repointed (identity is the NAME; forcing it
 *   corrupts the shared getters). Returns 'reload-required' — the caller
 *   reloads the page; boot then registers the override's version (or the
 *   default, after a clear) before anything loads.
 *
 * Dev-owned containers are never touched — the live dev build always wins.
 *
 * @param appId - The app id.
 * @param moduleId - The app's MF container name.
 * @param override - The override record, or null to reset to default.
 * @returns 'ready' when the switch can proceed in-place, else 'reload-required'.
 */
export function applyAppVersionOverride(
	appId: string,
	moduleId: string,
	override: AppVersionOverride | null,
): 'ready' | 'reload-required' {
	// The live dev build always wins — record/clear the override for later
	// sessions but never repoint a dev-owned container.
	if (isDevRemote(moduleId)) {
		if (override === null) clearAppVersionOverride(appId);
		else setAppVersionOverride(appId, override);
		return 'ready';
	}

	if (override === null) {
		// Reset to default resolution. If an override was ever stored this
		// session the container may sit at the overridden URL — only a fresh
		// boot deterministically restores the manifest default.
		const had = getAppVersionOverride(appId);
		clearAppVersionOverride(appId);
		return had ? 'reload-required' : 'ready';
	}

	setAppVersionOverride(appId, override);
	// A loaded container is committed to its version for this document
	if (isRemoteLoaded(moduleId)) return 'reload-required';
	// Not loaded yet — repoint the registration and evict the descriptor
	repointRemote(moduleId, versionedEntryUrl(appId, override.version));
	invalidateAppDescriptor(appId);
	return 'ready';
}
