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

/**
 * Returns true if pipeline execution is allowed for the given app.
 *
 * Ungated when:
 * - No client is connected (caller handles connection errors separately)
 * - Server is not SaaS (capabilities doesn't include 'saas')
 *
 * Gated when:
 * - Connected to a SaaS server AND subscribedApps doesn't include the appId
 *
 * @param client - The RocketRide client instance (may be undefined if disconnected).
 * @param appId  - App identifier to check (e.g. PIPE_BUILDER_APP_ID).
 * @returns True if the user may execute pipelines; false if subscription required.
 */
export function isSubscribed(client: RocketRideClient | undefined, appId: string): boolean {
	if (!client) return true;

	const info = client.getAccountInfo();
	if (!info) return true;

	// OSS / on-prem servers don't enforce subscriptions
	const capabilities: string[] = info.capabilities ?? [];
	if (!capabilities.includes('saas')) return true;

	// Check subscribedApps — entries may be plain strings or { appId, status } objects
	const apps: unknown[] = info.subscribedApps ?? [];
	return apps.some((entry) => {
		if (typeof entry === 'string') return entry === appId;
		if (entry && typeof entry === 'object' && 'appId' in entry) return (entry as { appId: string }).appId === appId;
		return false;
	});
}
