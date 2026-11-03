// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * useStripeKey — resolves the Stripe publishable key for the embedded
 * CheckoutModal over the shell bus (`host.stripeKey`).
 *
 * The key is not baked into the webview bundle: it is server-specific
 * (pk_test vs pk_live) and must match the Stripe account of the server the
 * host's billing client is connected to. The host learns it from the
 * unauthenticated server probe and serves it as the `host.stripeKey` op;
 * every webview that mounts checkout UI is a bus realm.
 *
 * A panel can mount before the server connection lands, so an empty result
 * is retried with bounded backoff and re-requested the moment the mirrored
 * connection state changes — otherwise key === '' would strand checkout for
 * the panel's whole lifetime.
 */

import { useEffect, useState } from 'react';
import { ConnectionManager } from 'shell';
import type { StripeKeyReason as StripeKeyUnavailableReason } from 'shared/ops/hostOps';

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
 * Fetch the connected server's Stripe publishable key from the host.
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
		const cm = ConnectionManager.getInstance();
		let disposed = false;
		// Once a non-empty key resolves it never changes for a server — settle
		// and stop asking. 'no-billing' is equally terminal (the OSS case).
		let settled = false;
		let attempt = 0;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;

		const request = (): void => {
			void cm.request('host.stripeKey', {} as never).then(
				(r) => apply(r as { key: string | null; reason?: StripeKeyUnavailableReason }),
				() => apply({ key: null, reason: 'probe-failed' })
			);
		};

		const apply = (info: { key: string | null; reason?: StripeKeyUnavailableReason }): void => {
			if (disposed) return;
			if (info.key) {
				settled = true;
				if (retryTimer) clearTimeout(retryTimer);
				setState({ key: info.key });
				return;
			}
			// The server answered and has no billing — terminal, retrying
			// cannot change it. Settle empty and keep the reason for the UI.
			if (info.reason === 'no-billing') {
				settled = true;
				if (retryTimer) clearTimeout(retryTimer);
			}
			// Skip the render when nothing changed — each retry answers with
			// the same empty state.
			setState((prev) => (prev.key === '' && prev.reason === info.reason ? prev : { key: '', reason: info.reason }));
			// Transient empty (no connection / probe failed) — retry with
			// backoff until the budget runs out; a connection change refills it.
			if (!settled && attempt < MAX_EMPTY_RETRIES) {
				const delay = BASE_RETRY_MS * 2 ** attempt;
				attempt += 1;
				retryTimer = setTimeout(request, delay);
			}
		};

		// Every connection change invalidates what we know: Stripe keys are
		// server-specific, so a disconnect must drop the settled key (or the
		// modal opens with the dead server's key). The mirror feed re-emits
		// shell:statusChange in every realm, so this covers both the
		// pre-connect mount and a server switch.
		const offStatus = cm.on('shell:statusChange', () => {
			if (disposed) return;
			settled = false;
			attempt = 0;
			if (retryTimer) clearTimeout(retryTimer);
			// The key AND the reason are unknown again — clear together.
			setState({ key: '' });
			if (cm.isConnected()) request();
		});

		request();

		return () => {
			disposed = true;
			offStatus();
			if (retryTimer) clearTimeout(retryTimer);
		};
	}, [enabled]);

	return state;
}
