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
// useSubscriptions — reads subscribed app IDs and statuses from ConnectResult
// =============================================================================

import { useMemo } from 'react';
import { useAuthUser } from './useAuthUser';

// =============================================================================
// TYPES
// =============================================================================

export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'incomplete';

interface SubscriptionEntry {
	appId: string;
	status: SubscriptionStatus;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Returns the set of app IDs the current user's primary organisation
 * is subscribed to, plus a status map for checking individual app states.
 *
 * The data comes from `ConnectResult.subscribedApps` which is populated
 * by the server (no additional network request). Each entry is an object
 * with `{ appId, status }` where status is one of:
 * - `active` / `trialing` / `past_due` — fully accessible
 * - `incomplete` — payment pending, shown as "Pending" in the UI
 */
export function useSubscriptions(): {
	subscribedAppIds: Set<string>;
	subscriptionStatuses: Map<string, SubscriptionStatus>;
} {
	const identity = useAuthUser();

	return useMemo(() => {
		const raw: (string | SubscriptionEntry)[] = identity?.subscribedApps ?? [];
		const ids = new Set<string>();
		const statuses = new Map<string, SubscriptionStatus>();

		for (const entry of raw) {
			if (typeof entry === 'string') {
				// Backwards compat: plain string means active
				ids.add(entry);
				statuses.set(entry, 'active');
			} else if (entry && typeof entry === 'object' && entry.appId) {
				ids.add(entry.appId);
				statuses.set(entry.appId, entry.status ?? 'active');
			}
		}

		return { subscribedAppIds: ids, subscriptionStatuses: statuses };
	}, [identity?.subscribedApps]);
}
