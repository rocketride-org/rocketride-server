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
 * Billing type definitions for the RocketRide TypeScript SDK.
 *
 * Data shapes for subscription management, compute credits, and Stripe
 * integration. These mirror the server's DAP response shapes without
 * importing any platform-specific modules.
 */

// =============================================================================
// SUBSCRIPTION TYPES
// =============================================================================

/**
 * Per-app subscription detail row returned by the `rrext_account_billing`
 * `list` subcommand. One row per subscribed app.
 */
export interface BillingDetail {
	/** App identifier matching AppManifestEntry.id (e.g. "brandi"). */
	appId: string;

	/** Stripe sub_* subscription identifier. */
	stripeSubscriptionId: string;

	/** Stripe price_* for the subscribed plan. */
	stripePriceId: string;

	/** One of: active, trialing, past_due, canceled. */
	status: string;

	/** ISO 8601 datetime when the current billing period ends, or null. */
	currentPeriodEnd: string | null;

	/** True when the user has requested cancellation at period end. */
	cancelAtPeriodEnd: boolean;
}

/**
 * Stripe plan/price row for a given product, returned by the `prices`
 * subcommand. Used in the checkout plan picker.
 */
export interface StripePlan {
	/** Stripe price_* identifier. */
	priceId: string;

	/** Billing interval: "month" or "year". */
	interval: 'month' | 'year';

	/** Price in USD cents. */
	unitAmount: number;

	/** Human-readable nickname, e.g. "Pro Monthly". */
	nickname: string;
}

// =============================================================================
// COMPUTE CREDITS TYPES
// =============================================================================

/**
 * Current credit balance for an organisation's compute wallet.
 * Returned by the `credits_balance` subcommand.
 */
export interface CreditBalance {
	/** Current unspent credit balance for the org. */
	balance: number;

	/** Total credits ever purchased — useful for ledger display. */
	lifetime_purchased: number;

	/** Total credits ever consumed — useful for ledger display. */
	lifetime_consumed: number;
}

/**
 * Per-pack pricing row for the credit top-up modal.
 * Mirrors the output of the Terraform `credit_packs` map so operators
 * can add/edit packs without a frontend deploy.
 */
export interface CreditPack {
	/** Terraform key ("small", "medium", "large"). */
	packId: string;

	/** Stripe price_* identifier for the one-off pack. */
	priceId: string;

	/** Cost of the pack in USD cents. */
	usdCents: number;

	/** Credits added to the wallet on successful purchase. */
	credits: number;

	/** Human-readable label, e.g. "55k credits (10% bonus)". */
	nickname: string;
}
