// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * useStripeKey — resolves the Stripe publishable key for the embedded
 * CheckoutModal from the extension host.
 *
 * The key is not baked into the webview bundle: it is server-specific
 * (pk_test vs pk_live) and must match the Stripe account of the server the
 * host's billing client is connected to. The host learns it from the
 * unauthenticated server probe (ServerInfoResult.stripePublishableKey) and
 * caches it per URI (see providers/shared/stripe-key.ts).
 *
 * Call it from the component that renders a CheckoutModal. It requests
 * `checkout:getStripeKey` and returns the `checkout:stripeKey` reply, ''
 * until it arrives (consumers already gate checkout UI on a non-empty key).
 * A panel can mount before the server connection lands, so an empty reply is
 * retried with bounded backoff and re-requested the moment a connection
 * arrives — otherwise key==='' would strand checkout for the panel's whole
 * lifetime. Uses the auxiliary-bridge pattern (own window listener +
 * getVsCodeApi) so it composes with the webview's main useMessaging without
 * re-running the view:ready handshake.
 */

import { useEffect, useState } from 'react';
import { getVsCodeApi } from './useMessaging';
import type { StripeKeyUnavailableReason } from '../../types/checkoutTypes';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Bounded backoff for an empty reply — a transient probe failure (the server
 *  not reachable yet) must not strand checkout, but the retries must not spin
 *  forever either. A landed connection refills this budget. */
const MAX_EMPTY_RETRIES = 5;
const BASE_RETRY_MS = 1000;

// =============================================================================
// HOOK
// =============================================================================

/** What useStripeKey resolves to: the key plus, while it is empty, the host's
 *  reason — so the consuming UI can explain the gap instead of rendering a
 *  silently dead Subscribe. */
export interface StripeKeyState {
	/** The server's publishable key, or '' while loading / unavailable. */
	key: string;
	/** Why `key` is empty — mirrors the host's last reply. Undefined while
	 *  loading, once a key resolves, or when the hook is disabled. */
	reason?: StripeKeyUnavailableReason;
}

/**
 * Fetch the connected server's Stripe publishable key from the extension host.
 *
 * @param enabled - Skip the request entirely when false (e.g. a CloudPanel
 *                  rendered without checkout callbacks never mounts a modal).
 * @returns The key state: `key` is '' while loading / when the server has no
 *          billing configured / when disabled, with `reason` saying why.
 */
export function useStripeKey(enabled = true): StripeKeyState {
	const [state, setState] = useState<StripeKeyState>({ key: '' });

	useEffect(() => {
		if (!enabled) return;

		// Once a non-empty key resolves it never changes for a server — settle
		// and stop asking. Until then an empty reply schedules a bounded backoff
		// retry, and a landed connection re-asks immediately (the first request
		// commonly races ahead of the server connection).
		let settled = false;
		let attempt = 0;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		// Monotonic request id: each request bumps it, and a reply is honored
		// only if it echoes the CURRENT id. This drops a stale reply from a
		// previous server (requested before a switch) that lands after the
		// re-request — otherwise it would clobber the new server's key.
		let requestId = 0;

		const request = (): void => {
			requestId += 1;
			getVsCodeApi()?.postMessage({ type: 'checkout:getStripeKey', requestId });
		};

		// Listen before asking so a fast host reply cannot be missed.
		const onHostMessage = (event: MessageEvent): void => {
			const message = event.data as { type?: string; key?: string; reason?: StripeKeyUnavailableReason; isConnected?: boolean; requestId?: number } | undefined;
			if (!message) return;

			if (message.type === 'checkout:stripeKey') {
				// Ignore a reply that does not answer the current request — a
				// stale key from a previous server would otherwise win a race.
				if (message.requestId !== requestId) return;
				// A real key settles the hook for good.
				if (message.key) {
					settled = true;
					if (retryTimer) clearTimeout(retryTimer);
					setState({ key: message.key });
					return;
				}
				// The server answered and has no billing — terminal, retrying
				// cannot change it (the OSS/standalone case). Settle empty so
				// the panel stops asking, and keep the reason for the UI.
				if (message.reason === 'no-billing') {
					settled = true;
					if (retryTimer) clearTimeout(retryTimer);
				}
				// Surface the reason (skip the render when nothing changed —
				// each retry answers with the same empty state).
				setState((prev) => (prev.key === '' && prev.reason === message.reason ? prev : { key: '', reason: message.reason }));
				// Transient empty (no connection / probe failed) — retry with
				// backoff until the budget runs out; a connection change
				// refills it.
				if (!settled && attempt < MAX_EMPTY_RETRIES) {
					const delay = BASE_RETRY_MS * 2 ** attempt;
					attempt += 1;
					retryTimer = setTimeout(request, delay);
				}
				return;
			}

			// A connection landing is the strongest re-request signal. It
			// covers BOTH the pre-connect mount (key==='' for the panel's
			// whole life otherwise) AND a server SWITCH: Stripe keys are
			// server-specific, so a new connection invalidates any key we
			// already settled on. Clear the settled state and the stale key
			// and re-ask, rather than keeping the previous server's key.
			if (message.type === 'shell:connectionChange' && message.isConnected) {
				settled = false;
				attempt = 0;
				if (retryTimer) clearTimeout(retryTimer);
				// A new server means both the key AND the reason are unknown
				// again — clear them together and re-ask.
				setState({ key: '' });
				request();
			}
		};
		window.addEventListener('message', onHostMessage);
		request();
		return () => {
			window.removeEventListener('message', onHostMessage);
			if (retryTimer) clearTimeout(retryTimer);
		};
	}, [enabled]);

	return state;
}
