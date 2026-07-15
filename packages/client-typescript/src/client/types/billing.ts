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

	/** Human-readable plan name from Stripe price nickname (e.g. "Pro Monthly"), or null. */
	planNickname: string | null;

	/** Price in USD cents for the subscribed plan, or null. */
	unitAmount: number | null;

	/** Billing interval: "month" or "year", or null. */
	billingInterval: string | null;

	/** ISO 8601 datetime when the current billing period started, or null. */
	currentPeriodStart: string | null;

	/** ISO 8601 datetime when the current billing period ends, or null. */
	currentPeriodEnd: string | null;

	/** True when the user has requested cancellation at period end. */
	cancelAtPeriodEnd: boolean;

	/** Credit grants config from Stripe price metadata, or null. */
	credits: { initial?: Record<string, number>; recurring?: Record<string, number> } | null;

	/** Display templates for credit resource types (e.g. ``{amount} minutes of Audio``), or null. */
	creditLabels: Record<string, string> | null;
}

/**
 * Alternative click action for a plan card. Plans without an action
 * proceed to Stripe checkout. Plans with an action navigate the user
 * elsewhere (e.g. GitHub repo for free tier, mailto for enterprise).
 */
export interface PlanAction {
	/** ``link`` opens a URL, ``mailto`` opens email compose. */
	type: 'link' | 'mailto';

	/** Target URL (for ``link``) or email address (for ``mailto``). */
	url: string;

	/** Optional email subject line (only for ``mailto``). */
	subject?: string;

	/** Button label shown on the card (e.g. "Get started", "Contact us"). */
	label: string;
}

/**
 * App pricing tier row from the ``app_prices`` table.
 * Returned by the ``prices`` subcommand. Used in the checkout plan picker.
 */
export interface AppPrice {
	/** Internal price UUID. */
	id: string;

	/** App identifier. */
	appId: string;

	/** Stripe price_* identifier. */
	stripePriceId: string;

	/** Human-readable tier label (e.g. "Starter", "Pro", "3,700 tokens"). */
	nickname: string;

	/** Price in smallest currency unit (e.g. cents for USD). */
	amountCents: number;

	/** ISO 4217 currency code. */
	currency: string;

	/** Billing interval: "month", "year", or "one_time". */
	interval: 'month' | 'year' | 'one_time' | '';

	/** Full plan metadata from the app manifest (description, action, order, kind, credits, labels, seats, features, etc.). */
	metadata?: Record<string, any> | null;

	/** Whether the price is active. */
	isActive: boolean;

	/** ISO 8601 creation timestamp. */
	createdAt: string | null;
}

/** @deprecated Use {@link AppPrice} instead. */
export type StripePlan = AppPrice;

// =============================================================================
// COMPUTE CREDITS TYPES
// =============================================================================

/**
 * Net credit balance for an organisation, grouped by resource.
 * Returned by the `credits_balance` subcommand.
 *
 * Balance is computed from ``SUM(amount) GROUP BY resource`` on the credit
 * ledger.  Positive = net credit remaining, negative = overspent.
 */
export interface CreditBalance {
	/** Net balance per resource type (positive = remaining, negative = overspent). */
	balances: Record<string, number>;

	/** Total credits granted (purchased/credited) per resource. */
	granted: Record<string, number>;

	/** Total credits consumed (debited) per resource. */
	consumed: Record<string, number>;

	/**
	 * Human-readable display templates per resource type, from Stripe price metadata.
	 * Supports ``{amount}`` substitution (e.g. ``"{amount} minutes of Audio"``).
	 * Falls back to the raw resource key when a label is not configured.
	 */
	labels: Record<string, string>;
}

// =============================================================================
// TRANSACTION TYPES
// =============================================================================

/**
 * A single ledger transaction row returned by the `transactions` subcommand.
 */
export interface LedgerTransaction {
	/** Auto-increment row ID. */
	id: number;

	/** Transaction type: purchase, usage, credit, refund, etc. */
	type: string;

	/** Resource type (e.g. cpu_utilization, gpu_memory, tokens). */
	resource: string;

	/** Signed amount: positive for credits, negative for debits. */
	amount: number;

	/** Namespaced idempotency key (e.g. task:abc123:cpu_utilization, stripe:cs_xxx:tokens). */
	idempotencyKey: string;

	/** User who triggered the transaction, or null for system events. */
	userId: string | null;

	/** Team context, or null. */
	teamId: string | null;

	/** Human-readable context (pipeline name, source, pack_id, etc.). */
	context: Record<string, any> | null;

	/** Line-item detail (e.g. gpu_memory, cpu_utilization). */
	description: string | null;

	/** ISO 8601 creation timestamp. */
	createdAt: string | null;
}

/**
 * Paginated result from the `transactions` subcommand.
 */
export interface TransactionsResult {
	/** Transaction rows for the current page. */
	transactions: LedgerTransaction[];

	/** Total matching rows (for pagination). */
	total: number;

	/** Current page number (1-based). */
	page: number;

	/** Rows per page. */
	pageSize: number;
}

/**
 * Per-user or per-team consumption rollup row returned by usage_by_user / usage_by_team.
 */
export interface UsageRollup {
	/** User or team ID (or '__none__' for unattributed). */
	id: string;

	/** Consumption per resource type (absolute values — always positive). */
	credits: Record<string, number>;
}

/**
 * Result of resolving a promo code via `promo_validate`.
 *
 * `valid: false` carries a human-readable `reason`. A grant/hackathon code
 * is recognisable by `appId` + `creditsGranted`; a discount-only code has
 * neither and applies to whichever plan is selected at checkout.
 */
export interface PromoValidation {
	/** Whether the code resolved to an active Stripe promotion code. */
	valid: boolean;

	/** Human-readable failure reason when `valid` is false. */
	reason?: string;

	/** Canonical code string as stored in Stripe. */
	code?: string;

	/** Stripe promo_* identifier (informational — never sent back). */
	promotionCodeId?: string;

	/** Human-readable description, e.g. "25% off for 3 months". */
	description?: string;

	/** Percentage discount (e.g. 25 or 100), if percent-based. */
	percentOff?: number | null;

	/** Fixed discount in cents, if amount-based. */
	amountOffCents?: number | null;

	/** ISO currency for `amountOffCents`. */
	currency?: string | null;

	/** Coupon duration: 'once' | 'repeating' | 'forever'. */
	duration?: string | null;

	/** Months the discount repeats for (duration === 'repeating'). */
	durationInMonths?: number | null;

	/** Credits granted on redemption ({resource: amount}) — grant codes only. */
	creditsGranted?: Record<string, number> | null;

	/** Target app for a grant code (e.g. "rocketride.pipeBuilder"). */
	appId?: string | null;

	/** List price in cents of the plan passed as priceId (if any). */
	amountCents?: number;

	/** First-invoice price in cents after the discount (if priceId given). */
	discountedAmountCents?: number;
}

/**
 * Result of redeeming a credit-grant code via `promo_redeem`.
 */
export interface PromoRedemption {
	/** True when the redemption succeeded. */
	redeemed: boolean;

	/** 'subscribed' = new $0 subscription created; 'credits_only' = org was already subscribed. */
	mode: 'subscribed' | 'credits_only';

	/** App the code targets. */
	appId: string;

	/** Subscription status after redemption (e.g. 'active'). */
	status?: string;

	/** Credits granted ({resource: amount}). */
	credits: Record<string, number>;
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
