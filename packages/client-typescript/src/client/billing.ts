/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Billing API namespace for the RocketRide TypeScript SDK.
 *
 * Provides typed methods for managing subscriptions, Stripe checkout
 * sessions, billing portal access, and compute credit wallets via DAP
 * commands over the existing WebSocket connection.
 */

import type { RocketRideClient } from './client.js';
import type { BillingDetail, StripePlan, CreditBalance, CreditPack } from './types/billing.js';

// =============================================================================
// BILLING API CLASS
// =============================================================================

/**
 * Typed wrapper around the `rrext_account_billing` DAP command.
 *
 * Accessed via `client.billing` — not instantiated directly. All methods
 * delegate to {@link RocketRideClient.dap} which handles envelope
 * unwrapping and error propagation.
 */
export class BillingApi {
	/** @param client - The parent RocketRideClient that owns this namespace. */
	constructor(private client: RocketRideClient) {}

	// =========================================================================
	// SUBSCRIPTION OPERATIONS
	// =========================================================================

	/**
	 * Fetches the per-app subscription details for the given org.
	 *
	 * @param orgId - Organisation UUID whose subscriptions to load.
	 * @returns Array of BillingDetail rows (one per subscribed app).
	 */
	async getDetails(orgId: string): Promise<BillingDetail[]> {
		const body = await this.client.call('rrext_account_billing', { subcommand: 'list', orgId });
		return body.subscriptions ?? [];
	}

	/**
	 * Fetches the active subscription plans (prices) for a Stripe product.
	 *
	 * Plans are returned sorted month-first, year-second, formatted for
	 * display in the checkout plan picker. The server calls
	 * `stripe.Price.list()` so pricing changes in the Stripe dashboard
	 * are reflected immediately.
	 *
	 * @param productId - Stripe prod_* identifier from AppManifestEntry.stripeProductId.
	 * @returns Array of StripePlan objects ready for display.
	 */
	async getProductPrices(productId: string): Promise<StripePlan[]> {
		const body = await this.client.call('rrext_account_billing', { subcommand: 'prices', productId });
		return body.plans ?? [];
	}

	/**
	 * Creates a Stripe subscription and returns the Stripe Elements client_secret.
	 *
	 * The returned client_secret is passed to `stripe.confirmPayment()` to
	 * complete the checkout without a browser redirect to Stripe.
	 *
	 * @param orgId   - Organisation UUID to subscribe.
	 * @param appId   - App being subscribed (e.g. "brandi").
	 * @param priceId - Stripe price_* identifier for the plan.
	 * @returns Object with client_secret for Stripe Elements and subscription_id.
	 */
	async createCheckoutSession(orgId: string, appId: string, priceId: string): Promise<{ clientSecret: string; subscriptionId: string }> {
		return this.client.call<{ clientSecret: string; subscriptionId: string }>('rrext_account_billing', {
			subcommand: 'subscribe',
			orgId,
			appId,
			priceId,
		});
	}

	/**
	 * Creates a Stripe Billing Portal session for managing payment methods.
	 *
	 * @param orgId     - Organisation UUID whose Stripe customer portal to open.
	 * @param returnUrl - URL to redirect the user back to after portal interaction.
	 * @returns Object with portal URL to redirect the user to.
	 */
	async createPortalSession(orgId: string, returnUrl: string): Promise<{ url: string }> {
		return this.client.call<{ url: string }>('rrext_account_billing', {
			subcommand: 'portal',
			orgId,
			returnUrl,
		});
	}

	/**
	 * Schedules an app subscription for cancellation at the end of the current period.
	 *
	 * The user retains access until the period ends. The webhook handler will
	 * update `cancel_at_period_end` in the database asynchronously.
	 *
	 * @param orgId - Organisation UUID that owns the subscription.
	 * @param appId - App to cancel (e.g. "brandi").
	 * @returns Object with canceled: true on success.
	 */
	async cancelSubscription(orgId: string, appId: string): Promise<{ canceled: boolean }> {
		return this.client.call<{ canceled: boolean }>('rrext_account_billing', {
			subcommand: 'cancel',
			orgId,
			appId,
		});
	}

	// =========================================================================
	// COMPUTE CREDITS WALLET
	// =========================================================================

	/**
	 * Reads the org's compute credit balance.
	 *
	 * The balance lives in a Redis-backed wallet on the engine side; this
	 * call is cheap and safe to poll (~1 req/s is fine for a live widget).
	 *
	 * @param orgId - Organisation UUID to query.
	 * @returns The credit balance with lifetime stats.
	 */
	async getCreditBalance(orgId: string): Promise<CreditBalance> {
		return this.client.call<CreditBalance>('rrext_account_billing', {
			subcommand: 'credits_balance',
			orgId,
		});
	}

	/**
	 * Loads the purchasable credit packs, sourced from the Stripe catalog
	 * that Terraform maintains. Call once on modal mount.
	 *
	 * @returns Array of credit pack pricing rows.
	 */
	async listCreditPacks(): Promise<CreditPack[]> {
		const body = await this.client.call('rrext_account_billing', { subcommand: 'credits_packs' });
		return body.packs ?? [];
	}

	/**
	 * Creates a one-off Stripe Checkout session for a credit pack purchase
	 * and returns the redirect URL.
	 *
	 * The frontend redirects the user to Stripe-hosted checkout; on success
	 * Stripe redirects back to the app, and the `checkout.session.completed`
	 * webhook increments the wallet server-side.
	 *
	 * @param orgId     - Organisation UUID that the credits belong to.
	 * @param packId    - Pack key returned by {@link listCreditPacks}.
	 * @param returnUrl - Where Stripe sends the user after payment.
	 * @returns Object with the Stripe checkout URL.
	 */
	async createCreditCheckout(orgId: string, packId: string, returnUrl: string): Promise<{ url: string }> {
		return this.client.call<{ url: string }>('rrext_account_billing', {
			subcommand: 'credits_checkout',
			orgId,
			packId,
			returnUrl,
		});
	}
}
