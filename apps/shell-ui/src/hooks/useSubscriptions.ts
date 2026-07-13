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
// useSubscriptions -- reads desktop/subscription state from AppRegistry
// =============================================================================

import { useMemo } from 'react';
import { isActiveStatus, type AppStatus } from 'rocketride';
import type { AppManifestEntry } from '../workspace/types';
import { useAppRegistry } from './AppRegistryContext';
import { useAuthUser } from './useAuthUser';

// =============================================================================
// TYPES
// =============================================================================

// AppStatus is the shared SDK type; re-export it so existing consumers that
// import it from here keep working.
export type { AppStatus };

/** @deprecated Use AppStatus instead. */
export type SubscriptionStatus = AppStatus;

// =============================================================================
// HOOK
// =============================================================================

/**
 * Desktop membership (from the app registry) + subscription status (from the
 * authoritative ``AccountInfo.subscriptions`` map on the cached ConnectResult).
 *
 * Desktop membership and subscription status are independent: an app can be
 * subscribed but not on the desktop, so ``getStatus`` reads the entitlement map
 * — refreshed on every ``apaext_account`` push — NOT the desktop-derived
 * registry. ``isOnDesktop`` still reflects the registry's ``onDesktop`` flag.
 */
export function useSubscriptions(): {
	desktopApps: AppManifestEntry[];
	/** Quick lookup: is this appId on the desktop? */
	isOnDesktop: (appId: string) => boolean;
	/** The app's subscription status (from AccountInfo.subscriptions), or undefined. */
	getStatus: (appId: string) => AppStatus | undefined;
	/** True when the app's status grants access (subscribed | trialing | free). */
	isSubscribed: (appId: string) => boolean;
} {
	const { apps } = useAppRegistry();
	const subscriptions = useAuthUser()?.subscriptions;

	return useMemo(() => {
		// Desktop membership comes from the registry (fed by getDesktop + push).
		const desktopSet = new Set<string>();
		const desktopApps: AppManifestEntry[] = [];
		for (const entry of apps) {
			if (entry?.id && entry.onDesktop) {
				desktopSet.add(entry.id);
				desktopApps.push(entry);
			}
		}

		return {
			desktopApps,
			isOnDesktop: (appId: string) => desktopSet.has(appId),
			getStatus: (appId: string) => subscriptions?.[appId] as AppStatus | undefined,
			isSubscribed: (appId: string) => isActiveStatus(subscriptions?.[appId]),
		};
	}, [apps, subscriptions]);
}
