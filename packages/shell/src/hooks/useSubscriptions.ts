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
// useSubscriptions — reads desktop apps from ConnectResult.apps
// =============================================================================

import { useMemo, useSyncExternalStore } from 'react';
import type { AppManifestEntry } from 'rocketride';
import { useAuthUser } from './useAuthUser';
import { getLocalAppEntries, getLocalAppsVersion, subscribeLocalApps } from '../util/appLoader';

// =============================================================================
// TYPES
// =============================================================================

/** App lifecycle status values computed server-side. */
export type AppStatus = 'auth' | 'free' | 'unsubscribed' | 'subscribed' | 'trialing' | 'past_due' | 'canceled';

/** @deprecated Use AppStatus instead. */
export type SubscriptionStatus = AppStatus;

// =============================================================================
// HOOK
// =============================================================================

/**
 * Returns the user's desktop apps from ``ConnectResult.apps``.
 *
 * Single source of truth for which apps are on the desktop and their
 * subscription status. Data arrives with the auth handshake and is
 * pushed live via ``apaext_account`` events.
 */
export function useSubscriptions(): {
	desktopApps: AppManifestEntry[];
	/** Quick lookup: is this appId on the desktop? */
	isOnDesktop: (appId: string) => boolean;
	/** Quick lookup: what's this app's appStatus? */
	getStatus: (appId: string) => AppStatus | undefined;
} {
	const identity = useAuthUser();
	// Local/dev registrations change at runtime (an App Builder preview, the
	// terminal dev loop) — subscribe so the desktop reflects them live.
	const localVersion = useSyncExternalStore(subscribeLocalApps, getLocalAppsVersion, getLocalAppsVersion);

	return useMemo(() => {
		// ``identity.apps`` is already the SDK's AppManifestEntry[] (from
		// ConnectResult.apps) — the true runtime shape of these desktop entries.
		// Local/dev apps the server has never heard of are appended: their
		// synthetic entries carry onDesktop + appStatus 'dev', so the app
		// under development gets a desktop card and passes isOnDesktop in
		// the tab that serves it — a dev registration is this user's most
		// deliberate possible "this app is mine, show it" signal.
		const server: AppManifestEntry[] = identity?.apps ?? [];
		const serverIds = new Set(server.map((entry) => entry?.id).filter(Boolean));
		const raw: AppManifestEntry[] = [...server, ...getLocalAppEntries().filter((entry) => !serverIds.has(entry.id))];

		// Build lookup maps for fast access
		const statusMap = new Map<string, AppStatus>();
		const desktopSet = new Set<string>();
		for (const entry of raw) {
			if (entry?.id) {
				statusMap.set(entry.id, (entry.appStatus ?? 'free') as AppStatus);
				if (entry.onDesktop) desktopSet.add(entry.id);
			}
		}

		return {
			desktopApps: raw,
			isOnDesktop: (appId: string) => desktopSet.has(appId),
			getStatus: (appId: string) => statusMap.get(appId),
		};
	}, [identity?.apps, localVersion]);
}
