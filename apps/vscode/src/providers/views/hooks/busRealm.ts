// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// BUS REALM — this webview as a spoke of the shell bus
// =============================================================================
//
// Attaches the realm's ConnectionManager op bus to the extension host's
// router (toolhost/busHost.ts) over the webview's postMessage channel, and
// installs the realm's RETAINED-TOPIC port:
//
//   - 'shell:status' / 'shell:account' / 'shell:services' — the framework's
//     retained topics (the services blob never rides a status tick). The
//     ConnectionManager's own subscriptions fold deliveries into its sync
//     readers and re-emit the shell events realm code already listens for.
//   - `mirror.event` — engine pushes (task/status events), a STREAM on the
//     broadcast lane, re-emitted as `shell:event` so controllers fold them
//     exactly as they folded events off their own socket.
//
// Bus traffic rides the `__rrbus` envelope on the SAME channel as any typed
// view messages — a useMessaging switch never sees it (no `type` field),
// and this module never sees the view's messages.
//
// This file is a realm's ONE bus attachment: every webview entry (sidebar
// and each framework page) calls attachBusRealm() once at module scope.
// A realm needs no socket and no authToken — engine access is
// `request('client.*')` against the extension host's broker.
// =============================================================================

import { ConnectionManager, attachRealmToRoot } from 'shell';
import type { IBusEndpoint } from 'shell';
import { getVsCodeApi } from './useMessaging';

/** The bus envelope key (must match shell busBridge.ts). */
const BUS_ENVELOPE = '__rrbus';

let attached = false;

/**
 * Attaches this realm to the extension host's bus router. Idempotent —
 * the realm has exactly one attachment for its lifetime (a rebooted
 * webview is a fresh realm and attaches fresh).
 */
export function attachBusRealm(): void {
	if (attached) return;
	try {
		attachBusRealmUnsafe();
	} catch (err) {
		// The bus attach must NEVER take the page down — a realm without a
		// bus degrades (no engine data) but still renders.
		console.error('[busRealm] attach failed:', err);
	}
}

function attachBusRealmUnsafe(): void {
	const api = getVsCodeApi();
	if (!api) return; // not inside a VS Code webview (tests, storybook)
	attached = true;

	const endpoint: IBusEndpoint = {
		post: (m) => api.postMessage(m),
		subscribe: (cb) => {
			const listener = (event: MessageEvent): void => {
				const m = event.data as Record<string, unknown> | null;
				if (m && typeof m === 'object' && typeof m[BUS_ENVELOPE] === 'string') cb(m);
			};
			window.addEventListener('message', listener);
			return () => window.removeEventListener('message', listener);
		},
	};

	const cm = ConnectionManager.getInstance();
	const attachment = attachRealmToRoot(cm.ops(), endpoint);

	// ── Retained topics ─────────────────────────────────────────────────────
	// The wire port makes this realm's publish/subscribe/read resolve against
	// the ROOT's registry. The ConnectionManager's own mirror subscriptions
	// ('shell:status'/'shell:account'/'shell:services') re-point onto it and
	// REPLAY the current snapshots — synchronous reads (isConnected,
	// getAccountInfo, getCachedServices) answer from the deliveries, and the
	// matching shell events re-emit locally. No pull, no priming: replay-on-
	// subscribe is the hydration.
	cm.setRetainedPort(attachment.retained);

	// Engine events are a STREAM, not state — they arrive on the broadcast
	// lane and re-emit locally with the payload shape preserved (shell:event
	// carries { event }, exactly as the socket path produced it).
	cm.handle('mirror.event', (params) => {
		cm.emit('shell:event', params as never);
	});
}
