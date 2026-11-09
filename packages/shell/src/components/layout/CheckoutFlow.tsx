// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// CHECKOUT FLOW — Stripe subscription checkout wired to shell events
// =============================================================================

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CheckoutModal } from '../../modules/checkout';
import { checkoutNotDispatched } from '../../modules/checkout/checkoutDispatch';
import type { CheckoutPlan, PromoValidation } from '../../modules/checkout';
import { ConnectionManager } from '../../connection/connection';
import { getCheckoutScope, matchesCheckoutScope, sameCheckoutScope } from '../../connection/checkoutScope';
import type { CheckoutScope } from '../../connection/checkoutScope';
import type { AppManifestEntry } from '../workspace/types';

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Props for the CheckoutFlow component.
 */
export interface CheckoutFlowProps {
	/** Stripe publishable key from API config. */
	stripeKey: string;
	/** Source endpoint when the key is fetched by an embedded host. */
	stripeServer?: string;
	/** Organization ID from the authenticated identity. */
	orgId: string;
}

/**
 * Listens for `shell:subscribe` events and renders the CheckoutModal
 * overlay when a user clicks "Subscribe" on a paid app.
 *
 * Wires up the Stripe checkout flow callbacks to the ConnectionManager's
 * billing API.
 */
export const CheckoutFlow: React.FC<CheckoutFlowProps> = ({ stripeKey, stripeServer, orgId }) => {
	const cm = ConnectionManager.getInstance();
	const [checkout, setCheckout] = useState<{
		id: number;
		scope: CheckoutScope;
		app: AppManifestEntry;
		plan?: CheckoutPlan;
		promo?: PromoValidation | null;
	} | null>(null);
	const [liveReplaySupported, setLiveReplaySupported] = useState(false);
	const activeCheckout = useRef<typeof checkout>(null);
	const checkoutSequence = useRef(0);
	const lastStripeKey = useRef<{ checkoutId: number; key: string } | null>(null);
	/** Pending timer that clears the post-purchase welcome status message. */
	const statusClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Cancel the pending status-message clear if we unmount first (e.g. logout
	// or navigation) so it doesn't emit after the component is gone.
	useEffect(() => () => {
		if (statusClearTimer.current) clearTimeout(statusClearTimer.current);
	}, []);

	useEffect(() => {
		const invalidate = () => {
			activeCheckout.current = null;
			setCheckout(null);
		};
		const checkScope = () => {
			const current = activeCheckout.current;
			const scope = getCheckoutScope(cm.getClient());
			if (current && (current.scope.orgId !== orgId || (scope && !sameCheckoutScope(scope, current.scope)))) {
				invalidate();
			} else if (scope) {
				setLiveReplaySupported(scope.replaySupported);
			}
		};
		checkScope();
		const off = [
			cm.on('shell:workspaceWillChange', invalidate),
			cm.on('shell:orgChanged', invalidate),
			cm.on('shell:logoutRequest', invalidate),
			cm.on('shell:connected', checkScope),
			cm.on('shell:accountUpdate', checkScope),
			cm.on('shell:subscribe', ({ app, plan, promo, checkoutScope }) => {
				const scope = getCheckoutScope(cm.getClient());
				if (!cm.isConnected() || !scope || scope.orgId !== orgId || !checkoutScope || !matchesCheckoutScope(scope, checkoutScope)) return;
				const entry = app as AppManifestEntry;
				const current = activeCheckout.current;
				// A second opening signal cannot replace an unresolved purchase.
				if (current && sameCheckoutScope(scope, current.scope)) return;
				const next = { id: ++checkoutSequence.current, scope: checkoutScope, app: entry, plan, promo };
				activeCheckout.current = next;
				setLiveReplaySupported(scope.replaySupported);
				setCheckout(next);
			}),
		];
		return () => off.forEach((unsubscribe) => unsubscribe());
	}, [cm, orgId]);

	// --- Listen for unsubscribe events ---------------------------------------
	useEffect(() => {
		return ConnectionManager.getInstance().on('shell:unsubscribe', ({ appId }: { appId: string }) => {
			const client = ConnectionManager.getInstance().getClient();
			if (orgId && client) {
				client.billing.cancelSubscription(orgId, appId)
					.then(() => console.log('[unsubscribe] canceled', appId))
					.catch((err) => console.error('[unsubscribe] error', err));
			}
		});
	}, [orgId]);

	const isCheckoutCurrent = () => checkout !== null && activeCheckout.current === checkout && cm.isConnected() &&
		matchesCheckoutScope(getCheckoutScope(cm.getClient()), checkout.scope);
	const replaySupported = checkout?.scope.replaySupported === true && liveReplaySupported;
	const matchingKey = checkout && (!stripeServer || stripeServer === checkout.scope.server) && isCheckoutCurrent() &&
		(!checkout.scope.replaySupported || replaySupported) ? stripeKey : '';
	useLayoutEffect(() => {
		if (checkout && matchingKey) lastStripeKey.current = { checkoutId: checkout.id, key: matchingKey };
	}, [checkout, matchingKey]);
	const checkoutStripeKey = checkout && lastStripeKey.current?.checkoutId === checkout.id ? lastStripeKey.current.key : matchingKey;

	if (!checkout || !checkoutStripeKey || checkout.scope.orgId !== orgId) return null;
	const { app: checkoutApp } = checkout;

	// --- Render CheckoutModal ------------------------------------------------
	// Engine access is the realm's own client, so this flow renders in any
	// realm (the real client at the cloud root; the realm client — requests
	// over the bridge — in a page webview).
	const needClient = () => {
		const client = cm.getClient();
		if (!client || !isCheckoutCurrent()) throw checkoutNotDispatched();
		return client;
	};

	return (
		<CheckoutModal
			key={checkout.id}
			appName={checkoutApp.name}
			appDescription={checkoutApp.description}
			stripePublishableKey={checkoutStripeKey}
			preselectedPlan={checkout.plan}
			preselectedPromo={checkout.promo}
			isCheckoutCurrent={isCheckoutCurrent}
			supportsCheckoutReplay={replaySupported}
			requireCheckoutStatus
			onFetchPlans={async () => {
				return needClient().billing.getProductPrices(checkoutApp.id) as Promise<CheckoutPlan[]>;
			}}
			onCreateCheckout={async (priceId, promotionCode, attemptId) => {
				return needClient().billing.createCheckoutSession(orgId, checkoutApp.id, priceId, promotionCode, attemptId);
			}}
			onValidatePromoCode={async (code: string, priceId?: string) => {
				return needClient().billing.validatePromoCode(orgId, code, priceId) as Promise<PromoValidation>;
			}}
			onRedeemPromoCode={async (code, attemptId) => {
				return needClient().billing.redeemPromoCode(orgId, code, attemptId) as Promise<never>;
			}}
			onConfirmPending={async (subscriptionId: string, priceId: string) => {
				// No SDK method exists for confirm_pending (the old direct-client
				// path called a phantom `dapRequest`); wrap the public call()
				// exactly as BillingApi wraps its other verbs.
				await needClient().call('rrext_account_billing', { subcommand: 'confirm_pending', appId: checkoutApp.id, subscriptionId, priceId });
			}}
			onSuccess={() => {
				if (!isCheckoutCurrent()) return;
				activeCheckout.current = null;
				// Payment can complete before the account shows an active subscription.
				const appId = checkoutApp.id;
				const appName = checkoutApp.name;
				setCheckout((current) => current === checkout ? null : current);
				const status = cm.getClient()?.getAccountInfo()?.apps?.find((app) => app.id === appId)?.appStatus;
				if (status === 'subscribed' || status === 'trialing') cm.emit('shell:switchApp', { appId });
				cm.emit('shell:statusMessage', { message: `Checkout completed for ${appName}.` });
				// Auto-clear so the confirmation doesn't linger in the status bar.
				// Tracked in a ref so it's cancelled if we unmount before it fires.
				if (statusClearTimer.current) clearTimeout(statusClearTimer.current);
				statusClearTimer.current = setTimeout(() => cm.emit('shell:statusMessage', { message: null }), 5000);
			}}
			onClose={() => {
				if (activeCheckout.current !== checkout) return;
				activeCheckout.current = null;
				setCheckout((current) => current === checkout ? null : current);
			}}
		/>
	);
};
