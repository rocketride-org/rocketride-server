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

import React, { useEffect, useState } from 'react';
import { CheckoutModal } from 'shared';
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

	// --- Listen for subscribe events -----------------------------------------
	useEffect(() => {
		return ConnectionManager.getInstance().on('shell:subscribe', ({ app }: { app: unknown }) => {
			setCheckoutApp(app as AppManifestEntry);
		});
	}, []);

	// --- Don't render if no checkout or missing config -----------------------
	if (!checkoutApp || !stripeKey || !orgId) return null;

	// --- Render CheckoutModal ------------------------------------------------
	const cm = ConnectionManager.getInstance();

	return (
		<CheckoutModal
			appName={checkoutApp.name}
			appDescription={checkoutApp.description}
			stripePublishableKey={stripeKey}
			onFetchPlans={async () => {
				const c = cm.getClient();
				if (!c) throw new Error('Not connected');
				return c.billing.getProductPrices(checkoutApp.id);
			}}
			onCreateCheckout={async (priceId: string) => {
				const c = cm.getClient();
				if (!c) throw new Error('Not connected');
				return c.billing.createCheckoutSession(orgId, checkoutApp.id, priceId);
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
			onSuccess={() => setCheckoutApp(null)}
			onClose={() => setCheckoutApp(null)}
		/>
	);
};
