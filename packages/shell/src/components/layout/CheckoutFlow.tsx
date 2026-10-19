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

import React, { useEffect, useRef, useState } from 'react';
import { CheckoutModal } from '../../modules/checkout';
import type { CheckoutPlan, PromoValidation } from '../../modules/checkout';
import { ConnectionManager } from '../../connection/connection';
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
export const CheckoutFlow: React.FC<CheckoutFlowProps> = ({ stripeKey, orgId }) => {
	/** App the user wants to subscribe to; null when modal is closed. */
	const [checkoutApp, setCheckoutApp] = useState<AppManifestEntry | null>(null);
	/** Optional plan preselected by the caller (e.g. the web pricing page) to
	 *  skip the picker and go straight to payment; null = show the picker. */
	const [presetPlan, setPresetPlan] = useState<CheckoutPlan | null>(null);
	/** Optional validated discount code passed alongside the preselected plan
	 *  (e.g. from the web pricing page) so it rides into the auto-advanced
	 *  checkout; null = no promo. Cleared whenever presetPlan is cleared. */
	const [presetPromo, setPresetPromo] = useState<PromoValidation | null>(null);
	/** Pending timer that clears the post-purchase welcome status message. */
	const statusClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Cancel the pending status-message clear if we unmount first (e.g. logout
	// or navigation) so it doesn't emit after the component is gone.
	useEffect(() => () => {
		if (statusClearTimer.current) clearTimeout(statusClearTimer.current);
	}, []);

	// --- Listen for subscribe events -----------------------------------------
	useEffect(() => {
		return ConnectionManager.getInstance().on(
			'shell:subscribe',
			({ app, plan, promo }: { app: unknown; plan?: CheckoutPlan; promo?: PromoValidation | null }) => {
				setCheckoutApp(app as AppManifestEntry);
				setPresetPlan(plan ?? null);
				setPresetPromo(promo ?? null);
			},
		);
	}, []);

	// --- Listen for unsubscribe events ---------------------------------------
	useEffect(() => {
		return ConnectionManager.getInstance().on('shell:unsubscribe', ({ appId }: { appId: string }) => {
			if (orgId) {
				ConnectionManager.getInstance().request('client.billing.cancelSubscription', { orgId, appId })
					.then(() => console.log('[unsubscribe] canceled', appId))
					.catch((err) => console.error('[unsubscribe] error', err));
			}
		});
	}, [orgId]);

	// --- Don't render if no checkout or missing config -----------------------
	if (!checkoutApp || !stripeKey || !orgId) return null;

	// --- Render CheckoutModal ------------------------------------------------
	// Engine access is the brokered billing ops, so this flow renders in any
	// realm (cloud root in-process; a page webview over the bridge).
	const cm = ConnectionManager.getInstance();

	return (
		<CheckoutModal
			appName={checkoutApp.name}
			appDescription={checkoutApp.description}
			stripePublishableKey={stripeKey}
			preselectedPlan={presetPlan ?? undefined}
			preselectedPromo={presetPromo ?? undefined}
			onFetchPlans={async () => {
				return cm.request('client.billing.getProductPrices', { appId: checkoutApp.id }) as Promise<CheckoutPlan[]>;
			}}
			onCreateCheckout={async (priceId: string, promotionCode?: string) => {
				return cm.request('client.billing.createCheckoutSession', { orgId, appId: checkoutApp.id, priceId, promotionCode }) as Promise<{ clientSecret: string | null; subscriptionId: string; status: string }>;
			}}
			onValidatePromoCode={async (code: string, priceId?: string) => {
				return cm.request('client.billing.validatePromoCode', { orgId, code, priceId }) as Promise<PromoValidation>;
			}}
			onRedeemPromoCode={async (code: string) => {
				return cm.request('client.billing.redeemPromoCode', { orgId, code }) as Promise<never>;
			}}
			onConfirmPending={async (subscriptionId: string, priceId: string) => {
				// The old direct-client path called a phantom `dapRequest` method
				// that does not exist on the SDK — the named op wraps the real
				// public client.call() at the broker.
				await cm.request('client.billing.confirmPending', { appId: checkoutApp.id, subscriptionId, priceId });
			}}
			onSuccess={() => {
				// New purchase complete: drop the user into the app they just bought
				// and confirm briefly, rather than leaving them on the pricing grid.
				// (Upgrades keep their own inline confirmation in UpgradeModal.)
				const appId = checkoutApp.id;
				const appName = checkoutApp.name;
				setCheckoutApp(null);
				setPresetPlan(null);
				setPresetPromo(null);
				cm.emit('shell:switchApp', { appId });
				cm.emit('shell:statusMessage', { message: `Welcome to ${appName}. Your plan is now active.` });
				// Auto-clear so the confirmation doesn't linger in the status bar.
				// Tracked in a ref so it's cancelled if we unmount before it fires.
				if (statusClearTimer.current) clearTimeout(statusClearTimer.current);
				statusClearTimer.current = setTimeout(() => cm.emit('shell:statusMessage', { message: null }), 5000);
			}}
			onClose={() => { setCheckoutApp(null); setPresetPlan(null); setPresetPromo(null); }}
		/>
	);
};
