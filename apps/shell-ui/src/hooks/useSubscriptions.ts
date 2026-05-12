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

import { useMemo } from 'react';
import type { AppManifestEntry } from '../workspace/types';
import { useAuthUser } from './useAuthUser';

// =============================================================================
// TYPES
// =============================================================================

/** Subscription status values from the server. */
export type SubscriptionStatus = 'free' | 'unsubscribed' | 'active' | 'trialing' | 'past_due' | 'incomplete' | 'canceled';

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
	/** Quick lookup: what's this app's subscription status? */
	getStatus: (appId: string) => SubscriptionStatus | undefined;
} {
	const identity = useAuthUser();

	return useMemo(() => {
		const raw: AppManifestEntry[] = identity?.apps ?? [];

		// Build a lookup map for fast access
		const statusMap = new Map<string, SubscriptionStatus>();
		for (const entry of raw) {
			if (entry?.id) {
				statusMap.set(entry.id, (entry.subscriptionStatus ?? 'free') as SubscriptionStatus);
			}
		}

		return {
			desktopApps: raw,
			isOnDesktop: (appId: string) => statusMap.has(appId),
			getStatus: (appId: string) => statusMap.get(appId),
		};
	}, [identity?.apps]);
}
