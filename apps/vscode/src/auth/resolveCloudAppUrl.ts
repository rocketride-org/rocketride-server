// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Resolve the Cloud web app URL for the same environment as the API endpoint
 * used for token exchange (`ROCKETRIDE_URI`).
 *
 * Only `api.*` hosts have a known `cloud.*` counterpart. Anything else
 * (localhost, custom deployments, unparseable input) falls back to production
 * cloud — `normalizeUri` is an API-URL normalizer (may preserve wss: and add
 * engine port 5565), so non-api hosts cannot be mapped to a usable web URL.
 */

import { RocketRideClient } from 'rocketride';

const FALLBACK = 'https://cloud.rocketride.ai/';

export function resolveCloudAppUrl(cloudApiUrl: string): string {
	try {
		const url = new URL(RocketRideClient.normalizeUri(cloudApiUrl));
		// Only an api.* host has a known cloud.* counterpart; anything else
		// (localhost, custom deployments) has no derivable web app URL.
		if (!url.hostname.startsWith('api.')) return FALLBACK;
		url.hostname = `cloud.${url.hostname.slice('api.'.length)}`;
		url.protocol = 'https:'; // normalizeUri preserves ws/wss; openExternal needs http(s)
		url.port = ''; // normalizeUri may have added the engine port (5565)
		url.pathname = '/';
		url.search = '';
		url.hash = '';
		return url.toString();
	} catch {
		return FALLBACK;
	}
}
