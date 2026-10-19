// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// HOST OPS — the cloud host's implementations
// =============================================================================
//
// The `host.*` vocabulary is declared in shared/ops/hostOps.ts; THIS file is
// the cloud side of it (apps/vscode/src/ops is the other). The cloud host
// runs in the browser page that owns the engine connection, so the
// implementations are direct browser/SDK calls — no bridging.
// =============================================================================

import { ConnectionManager, registerOpHandlers } from 'shell';
import type { OpImplTable } from 'shell';
import { RocketRideClient } from 'rocketride';
import { assertExternalUrl } from 'shared/ops/hostOps';
import type { HostOpMap, StripeKeyInfo } from 'shared/ops/hostOps';

/** The server's publishable key, probed once per page (a server's key never
 *  changes mid-session). Same probe the VS Code host uses, same reasons. */
let stripeKeyCache: StripeKeyInfo | null = null;

async function probeStripeKey(): Promise<StripeKeyInfo> {
	if (stripeKeyCache?.key) return stripeKeyCache;
	try {
		const info = await RocketRideClient.getServerInfo(window.location.origin, 5000);
		stripeKeyCache = info.stripePublishableKey ? { key: info.stripePublishableKey } : { key: null, reason: 'no-billing' };
	} catch {
		// Probe failure is transient — do not cache, a later ask may land.
		return { key: null, reason: 'probe-failed' };
	}
	return stripeKeyCache;
}

/**
 * Registers the cloud host's `host.*` implementations on the framework
 * root's bus. Idempotent (already-registered ops are kept) — call once
 * from the host app's module scope.
 */
export function registerRocketHostOps(): () => void {
	const impls: OpImplTable<HostOpMap> = {
		'host.openExternal': (p) => {
			window.open(assertExternalUrl(p.url), '_blank', 'noopener');
		},
		'host.stripeKey': () => probeStripeKey(),
		// This host's framework pages render as shell OVERLAYS (the modal
		// surface VS Code lacks): the OverlayManager's id set is the page
		// directory here. `popup` is the only mode served today — a full
		// loadPage-as-document-tab surface arrives with the page unification.
		'host.openPage': (p) => {
			if (!['account', 'settings', 'environment'].includes(p.page)) {
				throw new Error(`Unknown framework page: ${p.page}`);
			}
			ConnectionManager.getInstance().emit('shell:openOverlay', { id: p.page } as never);
		},
		// host.prefs.*: not served here yet (arrives with the page
		// unification); host.envSlots is a multi-connection (VS Code
		// dev/deploy) concern.
	};
	return registerOpHandlers<HostOpMap>(ConnectionManager.getInstance().ops(), impls);
}
