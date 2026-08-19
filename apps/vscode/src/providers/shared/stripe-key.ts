// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Stripe publishable key resolution — host-side helper.
 *
 * The publishable key is no longer baked into webview bundles at build time:
 * it is environment-specific (pk_test vs pk_live) and must match the Stripe
 * account of the server the extension is actually connected to. The server
 * advertises its key on the unauthenticated `rrext_public_probe`
 * (ServerInfoResult.stripePublishableKey); this module probes and caches it
 * per server URI so providers can attach it to the messages that open a
 * checkout (account:init, checkout:required).
 */

import { RocketRideClient } from 'rocketride';

// =============================================================================
// TYPES
// =============================================================================

/** Outcome of a publishable-key resolution. `probed` distinguishes "the
 *  server answered and has no billing" (terminal — stop asking) from "the
 *  probe never landed" (transient — a retry may help): both leave `key`
 *  empty, but only one of them is worth retrying or blaming on the network. */
export interface StripeKeyResolution {
	/** The server's publishable key, or '' when unavailable. */
	key: string;
	/** True when the probe answered (even with no key); false when there was
	 *  no client or the probe failed. */
	probed: boolean;
}

// =============================================================================
// CACHE
// =============================================================================

/** Probe results keyed by websocket URI — a server's key never changes mid-session. */
const keyCache = new Map<string, string>();

// =============================================================================
// RESOLUTION
// =============================================================================

/**
 * Resolves the Stripe publishable key for the server a client is connected to.
 *
 * Probes the client's server via `rrext_public_probe` on first call and caches
 * the result per URI, so repeated calls (every account:init, every run-gate
 * check) cost nothing after the first.
 *
 * @param client - A connected RocketRideClient whose server should be probed.
 * @returns The resolution: `key` is '' when the client is undefined, the
 *          server has no billing configured, or the probe fails; `probed`
 *          tells those apart — callers gate checkout UI on a non-empty key
 *          and derive the user-facing reason from `probed`.
 */
export async function getStripePublishableKey(client: RocketRideClient | undefined): Promise<StripeKeyResolution> {
	if (!client) return { key: '', probed: false };

	// Step 1: serve from cache when this server was already probed. A cached
	// '' is a real answer (billing-less server), so it counts as probed.
	const uri = client.getConnectionInfo().uri;
	if (keyCache.has(uri)) return { key: keyCache.get(uri) as string, probed: true };

	// Step 2: probe the server; cache '' on servers without billing so the
	// probe is not repeated for them either.
	try {
		const info = await RocketRideClient.getServerInfo(uri, 5000);
		const key = info.stripePublishableKey ?? '';
		keyCache.set(uri, key);
		return { key, probed: true };
	} catch (error) {
		// Probe failure (server down / no probe support) — do not cache, a
		// later attempt may succeed once the server is reachable again.
		console.log(`[stripe-key] probe failed for ${uri}: ${error}`);
		return { key: '', probed: false };
	}
}
