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
import type { BillingDetail, AppPrice, CreditBalance, CreditPack, PromoRedemption, PromoValidation, TransactionsResult, UsageRollup } from './types/billing.js';

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
	 * Fetches the active subscription plans (prices) for an app.
	 *
	 * Plans are returned sorted month-first, year-second, formatted for
	 * display in the checkout plan picker. The server resolves the app's
	 * Stripe product internally and calls `stripe.Price.list()` so pricing
	 * changes in the Stripe dashboard are reflected immediately.
	 *
	 * @param appId - App identifier (e.g. "rocketride.pipeBuilder").
	 * @returns Array of AppPrice rows from the local database.
	 */
	async getProductPrices(appId: string): Promise<AppPrice[]> {
		const body = await this.client.call('rrext_account_billing', { subcommand: 'prices', appId });
		return body.plans ?? [];
	}

	/**
	 * Creates a Stripe subscription and returns the Stripe Elements client_secret.
	 *
	 * The returned client_secret is passed to `stripe.confirmPayment()` to
	 * complete the checkout without a browser redirect to Stripe.
	 *
	 * `clientSecret` is `null` when the first invoice is $0 (e.g. a 100%-off
	 * promotion code) — the subscription is already active and no payment
	 * step is needed.
	 *
	 * @param orgId         - Organisation UUID to subscribe.
	 * @param appId         - App being subscribed (e.g. "brandi").
	 * @param priceId       - Stripe price_* identifier for the plan.
	 * @param promotionCode - Optional promo code to apply (validated server-side).
	 * @returns Object with client_secret (or null), subscription_id, and status.
	 */
	async createCheckoutSession(orgId: string, appId: string, priceId: string, promotionCode?: string): Promise<{ clientSecret: string | null; subscriptionId: string; status: string }> {
		return this.client.call<{ clientSecret: string | null; subscriptionId: string; status: string }>('rrext_account_billing', {
			subcommand: 'subscribe',
			orgId,
			appId,
			priceId,
			...(promotionCode ? { promotionCode } : {}),
		});
	}

	/**
	 * Resolves a promo code without side effects.
	 *
	 * An unknown or expired code returns `{ valid: false, reason }` — it never
	 * throws. Pass `priceId` to also get the discounted first-invoice amount
	 * for the selected plan.
	 *
	 * @param orgId   - Organisation UUID (context only — validation is global).
	 * @param code    - Customer-facing code string (case-insensitive).
	 * @param priceId - Optional plan to compute `discountedAmountCents` against.
	 * @returns Promo validation result.
	 */
	async validatePromoCode(orgId: string, code: string, priceId?: string): Promise<PromoValidation> {
		return this.client.call<PromoValidation>('rrext_account_billing', {
			subcommand: 'promo_validate',
			orgId,
			code,
			...(priceId ? { priceId } : {}),
		});
	}

	/**
	 * Redeems a credit-grant (hackathon) code for the caller's org.
	 *
	 * Creates a $0 subscription for the app named in the code's metadata (no
	 * payment method required) and grants the metadata-defined credits
	 * immediately. If the org is already subscribed to the app, only the
	 * credits are granted (`mode: 'credits_only'`). Discount-only codes are
	 * rejected — those are applied during checkout instead.
	 *
	 * Any authenticated org member may redeem; the server derives the org
	 * from the caller's own membership.
	 *
	 * @param orgId - Organisation UUID (context only — server uses the caller's org).
	 * @param code  - Customer-facing code string (case-insensitive).
	 * @returns Redemption result with mode and granted credits.
	 */
	async redeemPromoCode(orgId: string, code: string): Promise<PromoRedemption> {
		return this.client.call<PromoRedemption>('rrext_account_billing', {
			subcommand: 'promo_redeem',
			orgId,
			code,
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

	/**
	 * Upgrades (or downgrades) an existing subscription to a different plan.
	 *
	 * The server swaps the Stripe subscription item to the new price and
	 * handles proration automatically. The local database row is updated
	 * before the response is returned.
	 *
	 * @param orgId      - Organisation UUID that owns the subscription.
	 * @param appId      - App whose plan is changing (e.g. "rocketride.pipeBuilder").
	 * @param newPriceId - Stripe price_* identifier for the target plan.
	 * @returns Object with status, new plan details, and subscription ID.
	 */
	async upgradeSubscription(orgId: string, appId: string, newPriceId: string): Promise<{
		status: string;
		subscriptionId: string;
		newPriceId: string;
		planNickname: string | null;
		unitAmount: number | null;
		billingInterval: string | null;
	}> {
		return this.client.call('rrext_account_billing', {
			subcommand: 'upgrade',
			orgId,
			appId,
			newPriceId,
		});
	}

	// =========================================================================
	// TOP-UP PURCHASE
	// =========================================================================

	/**
	 * Purchases a top-up pack by charging the customer's card on file.
	 *
	 * On success, credits are applied to the ledger immediately (no webhook
	 * needed). If the card requires 3D Secure, returns a ``clientSecret``
	 * for the UI to handle inline.
	 *
	 * @param orgId   - Organisation UUID.
	 * @param priceId - Stripe price_* identifier for the top-up plan.
	 * @returns Object with ``status`` ('succeeded' or 'requires_action') and
	 *          optionally ``clientSecret`` for 3DS.
	 */
	async purchaseTopup(orgId: string, priceId: string): Promise<{ status: string; clientSecret?: string }> {
		return this.client.call<{ status: string; clientSecret?: string }>('rrext_account_billing', {
			subcommand: 'purchase_topup',
			orgId,
			priceId,
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

	// =========================================================================
	// TRANSACTIONS & USAGE
	// =========================================================================

	/**
	 * Fetches paginated transaction detail from the credit ledger.
	 *
	 * @param orgId    - Organisation UUID.
	 * @param options  - Pagination and scope options.
	 * @returns Paginated transaction result.
	 */
	async getTransactions(
		orgId: string,
		options: { scope?: 'org' | 'team' | 'user'; scopeId?: string; page?: number; pageSize?: number; since?: string } = {},
	): Promise<TransactionsResult> {
		return this.client.call<TransactionsResult>('rrext_account_billing', {
			subcommand: 'transactions',
			orgId,
			...options,
		});
	}

	/**
	 * Fetches per-user consumption rollup for an org.
	 *
	 * @param orgId - Organisation UUID.
	 * @returns Array of usage rollup rows ordered by total consumption descending.
	 */
	async getUsageByUser(orgId: string): Promise<UsageRollup[]> {
		const body = await this.client.call('rrext_account_billing', { subcommand: 'usage_by_user', orgId });
		return body.usage ?? [];
	}

	/**
	 * Fetches per-team consumption rollup for an org.
	 *
	 * @param orgId - Organisation UUID.
	 * @returns Array of usage rollup rows ordered by total consumption descending.
	 */
	async getUsageByTeam(orgId: string): Promise<UsageRollup[]> {
		const body = await this.client.call('rrext_account_billing', { subcommand: 'usage_by_team', orgId });
		return body.usage ?? [];
	}

	// =========================================================================
	// CREDIT PACK CHECKOUT
	// =========================================================================

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
