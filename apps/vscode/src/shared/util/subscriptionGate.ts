// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Subscription gate utility for the VS Code extension.
 *
 * Checks whether the current user is subscribed to a given app by inspecting
 * the `subscriptions` map on the cached ConnectResult. Pipeline execution and
 * deployment are gated behind an active subscription on SaaS servers.
 */

import { isActiveStatus } from 'rocketride';
import type { RocketRideClient } from 'rocketride';

/**
 * Returns true if pipeline execution is allowed for the given app.
 *
 * Ungated when:
 * - No client is connected (caller handles connection errors separately)
 * - No account info is cached yet
 * - Server is not SaaS (capabilities doesn't include 'saas')
 *
 * Gated when:
 * - Connected to a SaaS server AND the app's subscription status is not active
 *   (`isActiveStatus` = 'subscribed' | 'trialing' | 'free'). 'unsubscribed',
 *   'past_due', 'canceled', 'auth', or an absent entry all gate.
 *
 * The status comes from `ConnectResult.subscriptions` (the full entitlement,
 * independent of desktop placement), refreshed on every `apaext_account` push.
 *
 * @param client - The RocketRide client instance (may be undefined if disconnected).
 * @param appId  - App identifier to check (e.g. PIPE_BUILDER_APP_ID).
 * @returns True if the user may execute pipelines; false if subscription required.
 */
export function isSubscribed(client: RocketRideClient | undefined, appId: string): boolean {
	if (!client) return true;

	const info = client.getAccountInfo();
	if (!info) return true;

	// OSS / on-prem servers don't enforce subscriptions.
	const capabilities: string[] = info.capabilities ?? [];
	if (!capabilities.includes('saas')) return true;

	return isActiveStatus(info.subscriptions?.[appId]);
}
