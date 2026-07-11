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
import { CheckoutModal } from 'shared';
import type { CheckoutPlan } from 'shared';
import { ConnectionManager } from '../../connection/connection';
import type { AppManifestEntry } from '../../workspace/types';

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
			({ app, plan }: { app: unknown; plan?: CheckoutPlan }) => {
				setCheckoutApp(app as AppManifestEntry);
				setPresetPlan(plan ?? null);
			},
		);
	}, []);

	// --- Listen for unsubscribe events ---------------------------------------
	useEffect(() => {
		return ConnectionManager.getInstance().on('shell:unsubscribe', ({ appId }: { appId: string }) => {
			const client = ConnectionManager.getInstance().getClient();
			if (client && orgId) {
				client.billing.cancelSubscription(orgId, appId)
					.then(() => console.log('[unsubscribe] canceled', appId))
					.catch((err) => console.error('[unsubscribe] error', err));
			}
		});
	}, [orgId]);

	// --- Don't render if no checkout or missing config -----------------------
	if (!checkoutApp || !stripeKey || !orgId) return null;

	// --- Render CheckoutModal ------------------------------------------------
	const cm = ConnectionManager.getInstance();

	return (
		<CheckoutModal
			appName={checkoutApp.name}
			appDescription={checkoutApp.description}
			stripePublishableKey={stripeKey}
			preselectedPlan={presetPlan ?? undefined}
			onFetchPlans={async () => {
				const c = cm.getClient();
				if (!c) throw new Error('Not connected');
				return c.billing.getProductPrices(checkoutApp.id);
			}}
			onCreateCheckout={async (priceId: string, promotionCode?: string) => {
				const c = cm.getClient();
				if (!c) throw new Error('Not connected');
				return c.billing.createCheckoutSession(orgId, checkoutApp.id, priceId, promotionCode);
			}}
			onValidatePromoCode={async (code: string, priceId?: string) => {
				const c = cm.getClient();
				if (!c) throw new Error('Not connected');
				return c.billing.validatePromoCode(orgId, code, priceId);
			}}
			onRedeemPromoCode={async (code: string) => {
				const c = cm.getClient();
				if (!c) throw new Error('Not connected');
				return c.billing.redeemPromoCode(orgId, code);
			}}
			onConfirmPending={async (subscriptionId: string, priceId: string) => {
				const c = cm.getClient();
				if (!c) return;
				await (c as any).dapRequest('rrext_account_billing', {
					subcommand: 'confirm_pending',
					appId: checkoutApp.id,
					subscriptionId,
					priceId,
				});
			}}
			onSuccess={() => {
				// New purchase complete: drop the user into the app they just bought
				// and confirm briefly, rather than leaving them on the pricing grid.
				// (Upgrades keep their own inline confirmation in UpgradeModal.)
				const appId = checkoutApp.id;
				const appName = checkoutApp.name;
				setCheckoutApp(null);
				setPresetPlan(null);
				cm.emit('shell:switchApp', { appId });
				cm.emit('shell:statusMessage', { message: `Welcome to ${appName} — your plan is now active.` });
				// Auto-clear so the confirmation doesn't linger in the status bar.
				// Tracked in a ref so it's cancelled if we unmount before it fires.
				if (statusClearTimer.current) clearTimeout(statusClearTimer.current);
				statusClearTimer.current = setTimeout(() => cm.emit('shell:statusMessage', { message: null }), 5000);
			}}
			onClose={() => { setCheckoutApp(null); setPresetPlan(null); }}
		/>
	);
};
