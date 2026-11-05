// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Subscription gate utility for the VS Code extension.
 *
 * Checks whether the current user is subscribed to a given app by inspecting
 * the cached ConnectResult. Pipeline execution and deployment are gated
 * behind an active subscription on SaaS servers.
 */

import type { RocketRideClient } from 'rocketride';
import { isAppSubscribed } from 'shared/utils/subscriptionGate';

/**
 * Returns true if pipeline execution is allowed for the given app — the
 * client-flavored wrapper over the shared account predicate
 * (shared/utils/subscriptionGate: the ONE implementation; realms apply it to
 * their mirrored account snapshot).
 *
 * @param client - The RocketRide client instance (may be undefined if disconnected).
 * @param appId  - App identifier to check (e.g. PIPE_BUILDER_APP_ID).
 * @returns True if the user may execute pipelines; false if subscription required.
 */
export function isSubscribed(client: RocketRideClient | undefined, appId: string): boolean {
	if (!client) return true;
	return isAppSubscribed(client.getAccountInfo(), appId);
}
