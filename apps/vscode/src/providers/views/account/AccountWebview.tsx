// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AccountWebview — the Account framework page as a shell bus realm.
 *
 * The page IS the shell's own AccountProvider (the same component the cloud
 * overlay renders), running socketless: every engine call rides the brokered
 * `client.account.*` / `client.billing.*` bus ops and connection/account
 * state arrives on the mirror feed. This file adds only the host-specific
 * seams the shell cannot own:
 *
 *   - the bus-realm attachment (module scope, once),
 *   - the bridged prefs store (host memento bag over `host.prefs.*`) so
 *     DataGrid layouts persist exactly as in the web shell,
 *   - the Stripe publishable key (host-probed via `host.stripeKey`),
 *   - the subscribe entry point: `shell:subscribe` toward the mounted
 *     CheckoutFlow, or the unavailable notice when the server has no key.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AccountProvider, CheckoutFlow, ConnectionManager, createBridgedPrefsStore, useGridConfigAnswering } from 'shell';
import type { ConnectResult } from 'rocketride';
import { attachBusRealm } from '../hooks/busRealm';
import { CheckoutUnavailableNotice } from '../components/CheckoutUnavailableNotice';
import type { StripeKeyReason as StripeKeyUnavailableReason } from 'shared/ops/hostOps';

attachBusRealm();

/** The one subscribable app this host offers (same identity the old page
 *  hardcoded into its CheckoutModal). */
const PIPE_BUILDER_APP = {
	id: 'rocketride.pipeBuilder',
	name: 'Pipe Builder',
	description: 'Visual AI pipeline editor: run and deploy pipelines on RocketRide Cloud.',
};

/**
 * VS Code webview entry point for the Account page.
 */
const AccountWebview: React.FC = () => {
	const cm = ConnectionManager.getInstance();

	// ── Prefs: hydrate once from the host's memento bag; writes are
	//    fire-and-forget ops. Grid layouts answer synchronously from the
	//    store, so DataGrid persistence works exactly as in the web shell.
	const prefsBridgeRef = useRef<ReturnType<typeof createBridgedPrefsStore> | null>(null);
	if (!prefsBridgeRef.current) {
		prefsBridgeRef.current = createBridgedPrefsStore((key, value, scope) => cm.emitOp('host.prefs.set', { key, value, scope }));
	}
	useGridConfigAnswering(prefsBridgeRef.current.store);
	useEffect(() => {
		void cm.request('host.prefs.snapshot', {}).then(
			(snap) => prefsBridgeRef.current?.seed(snap as Record<string, unknown>),
			() => prefsBridgeRef.current?.seed({})
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── Stripe key (host-probed; matches the CONNECTED server's account).
	const [stripe, setStripe] = useState<{ key: string | null; reason?: StripeKeyUnavailableReason } | null>(null);
	useEffect(() => {
		void cm.request('host.stripeKey', {}).then(
			(r) => setStripe(r as { key: string | null; reason?: StripeKeyUnavailableReason }),
			() => setStripe({ key: null, reason: 'probe-failed' })
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── orgId for CheckoutFlow — mirrored account info.
	const [account, setAccount] = useState<ConnectResult | null>(() => cm.getAccountInfo() ?? null);
	useEffect(() => cm.on('shell:accountUpdate', (data) => setAccount(data)), [cm]);
	const orgId = account?.organization?.id ?? '';

	// ── Subscribe entry point: hand off to CheckoutFlow, or explain why not.
	const [showUnavailable, setShowUnavailable] = useState(false);
	const handleSubscribe = useCallback(() => {
		if (!stripe?.key) {
			setShowUnavailable(true);
			return;
		}
		cm.emit('shell:subscribe', { app: PIPE_BUILDER_APP } as never);
	}, [cm, stripe]);

	return (
		<>
			<AccountProvider onSubscribe={handleSubscribe} />
			<CheckoutFlow stripeKey={stripe?.key ?? ''} orgId={orgId} />
			{showUnavailable && <CheckoutUnavailableNotice reason={stripe?.reason} onClose={() => setShowUnavailable(false)} />}
		</>
	);
};

export default AccountWebview;
