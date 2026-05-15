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
// BILLING VIEW — thin shell-ui wrapper around shared-ui BillingView.
//
// Owns all DAP fetching via billingApi and passes pure data + callbacks
// down to the host-agnostic BillingView.
// =============================================================================

import React, { useEffect, useState, useCallback } from 'react';
import { BillingView } from 'shared';
import type { BillingDetail, CreditBalance, CreditPack } from 'rocketride';
import { useShellConnection } from '../../connection/ConnectionContext';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useWorkspace } from '../../workspace/WorkspaceContext';

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Cloud-UI BillingView wrapper.
 *
 * Fetches subscription data, credit balance, and credit packs via the
 * shared billingApi DAP wrappers, then delegates all rendering to the
 * shared-ui BillingView component.
 */
const BillingPage: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
	const { client, isConnected } = useShellConnection();
	const identity = useAuthUser();
	const { appManifest } = useWorkspace();

	// ── State ────────────────────────────────────────────────────────────────
	const [subscriptions, setSubscriptions] = useState<BillingDetail[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [creditBalance, setCreditBalance] = useState<CreditBalance | null>(
		(identity as { credits?: CreditBalance })?.credits ?? null,
	);
	const [creditPacks, setCreditPacks] = useState<CreditPack[]>([]);

	const orgId = identity?.organizations?.[0]?.id ?? '';

	// ── Load data when connected ─────────────────────────────────────────────
	useEffect(() => {
		if (!client || !isConnected || !orgId) {
			setLoading(false);
			return;
		}

		let cancelled = false;
		setLoading(true);
		setError(null);

		// Fetch subscriptions, credit balance, and credit packs in parallel
		Promise.all([
			client.billing.getDetails(orgId).catch((err: any) => {
				if (!cancelled) setError(err.message ?? 'Failed to load subscriptions');
				return [] as BillingDetail[];
			}),
			client.billing.getCreditBalance(orgId).catch(() => null),
			client.billing.listCreditPacks().catch(() => [] as CreditPack[]),
		]).then(([subs, balance, packs]) => {
			if (cancelled) return;
			setSubscriptions(subs);
			setCreditBalance(balance);
			setCreditPacks(packs);
		}).finally(() => {
			if (!cancelled) setLoading(false);
		});

		return () => { cancelled = true; };
	}, [client, isConnected, orgId]);

	// ── Callbacks ────────────────────────────────────────────────────────────

	/**
	 * Cancels a subscription and re-fetches the updated list.
	 * @param appId - The app whose subscription to cancel.
	 */
	const handleCancel = useCallback(async (appId: string) => {
		if (!client || !orgId) return;
		await client.billing.cancelSubscription(orgId, appId);
		// Re-fetch to reflect the updated subscription state
		const updated = await client.billing.getDetails(orgId);
		setSubscriptions(updated);
	}, [client, orgId]);

	/**
	 * Opens the Stripe customer portal for payment method management.
	 */
	const handlePortal = useCallback(async () => {
		if (!client || !orgId) return;
		const returnUrl = `${window.location.origin}${window.location.pathname}`;
		const { url } = await client.billing.createPortalSession(orgId, returnUrl);
		window.open(url, '_blank', 'noopener');
	}, [client, orgId]);

	/**
	 * Initiates a credit pack purchase via Stripe hosted checkout.
	 * @param pack - The credit pack to purchase.
	 */
	const handleBuyCredits = useCallback(async (pack: CreditPack) => {
		if (!client || !orgId) return;
		const returnUrl = `${window.location.origin}${window.location.pathname}`;
		const { url } = await client.billing.createCreditCheckout(orgId, pack.packId, returnUrl);
		window.location.href = url;
	}, [client, orgId]);

	// ── Render ──────────────────────────────────────────────────────────────
	return (
		<BillingView
			isConnected={isConnected}
			subscriptions={subscriptions}
			loading={loading}
			error={error}
			creditBalance={creditBalance}
			creditPacks={creditPacks}
			onCancelSubscription={handleCancel}
			onOpenPortal={handlePortal}
			onBuyCredits={handleBuyCredits}
			apps={appManifest}
		/>
	);
};

export default BillingPage;
