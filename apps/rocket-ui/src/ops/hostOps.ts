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

import { ConnectionManager, HOST_CONNECTION_TOPIC, registerOpHandlers } from 'shell';
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
			// 'environment' and 'account' are legacy vocabulary: both are
			// Settings sections now — deep-link instead of standalone overlays.
			// An 'account' open's first arg may name a sub-page ('billing').
			if (p.page === 'environment') {
				ConnectionManager.getInstance().emit('shell:openOverlay', { id: 'settings', section: 'environment' } as never);
				return;
			}
			if (p.page === 'account') {
				const sub = p.args?.[0];
				const section = sub === 'billing' ? 'account:billing' : sub === 'api-keys' ? 'account:keys' : 'account:profile';
				ConnectionManager.getInstance().emit('shell:openOverlay', { id: 'settings', section } as never);
				return;
			}
			ConnectionManager.getInstance().emit('shell:openOverlay', { id: p.page } as never);
		},
		// NOT here: the prefs ops. The WORKSPACE MANAGER serves those (shell
		// ops/prefsHost.ts), because it is the single writer and this
		// module has no handle on it. host.envSlots is a multi-connection
		// (VS Code dev/deploy) concern.
	};

	// ── host:connection — the LEVEL-DRIVEN system topic ─────────────────────
	// The host (not a React component) owns this: publish the current truth
	// now and re-publish on every connection edge. The former publisher — a
	// DevToolMount useEffect keyed on [isConnected] — missed republished
	// topics whenever the retained value went stale WITHOUT its hook value
	// changing (a reconnect cycle), stranding every useConnectionReady
	// consumer on a false snapshot while the host was demonstrably connected.
	const cm = ConnectionManager.getInstance();
	const syncConnection = (): void => {
		cm.publish(HOST_CONNECTION_TOPIC, { connected: cm.isConnected() });
	};
	cm.on('shell:connected', syncConnection);
	cm.on('shell:disconnected', syncConnection);
	syncConnection();

	return registerOpHandlers<HostOpMap>(ConnectionManager.getInstance().ops(), impls);
}
