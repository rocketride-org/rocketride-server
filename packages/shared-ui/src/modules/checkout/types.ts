// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Checkout module type definitions.
 *
 * Shapes for the plan picker and checkout flow. These mirror the server's
 * DAP response shapes from the `rrext_account_billing` `prices` subcommand.
 */

// =============================================================================
// PLAN ACTION
// =============================================================================

/**
 * Defines an alternative click action for a plan card.
 *
 * Plans without an action proceed to Stripe checkout as normal.
 * Plans with an action navigate the user elsewhere instead (e.g. a
 * GitHub repo for a free/OSS tier, or a mailto for enterprise sales).
 */
export interface PlanAction {
	/** Action type: ``link`` opens a URL, ``mailto`` opens an email compose. */
	type: 'link' | 'mailto';

	/** Target URL (for ``link``) or email address (for ``mailto``). */
	url: string;

	/** Optional email subject line (only used when type is ``mailto``). */
	subject?: string;

	/** Button label shown on the card (e.g. "Get started", "Contact us"). */
	label: string;
}

// =============================================================================
// CHECKOUT PLAN
// =============================================================================

/**
 * A single plan card shown in the CheckoutModal plan picker.
 *
 * Mirrors the ``app_prices`` DB row shape returned by ``_price_to_dict``.
 * The UI reads display fields from ``metadata`` (description, action, order, etc.).
 */
export interface CheckoutPlan {
	/** Internal price UUID. */
	id: string;

	/** App identifier. */
	appId: string;

	/** Stripe price_* identifier. Passed to the checkout session creation. */
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

// =============================================================================
// PROMO CODES
// =============================================================================

/**
 * UI-local result of validating a promo code via the host callback.
 *
 * Mirrors the SDK's `PromoValidation` response shape. A grant/hackathon
 * code is recognisable by `appId` + `creditsGranted`; a discount-only code
 * has neither and applies to whichever plan is selected.
 */
export interface PromoValidation {
	/** Whether the code resolved to an active Stripe promotion code. */
	valid: boolean;

	/** Human-readable failure reason when `valid` is false. */
	reason?: string;

	/** Canonical code string as stored in Stripe. */
	code?: string;

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

	/** Target app for a grant code — presence marks a hackathon/grant code. */
	appId?: string | null;

	/** List price in cents of the plan passed as priceId (if any). */
	amountCents?: number;

	/** First-invoice price in cents after the discount (if priceId given). */
	discountedAmountCents?: number;
}

/**
 * UI-local result of redeeming a credit-grant code via the host callback.
 * Mirrors the SDK's `PromoRedemption` response shape.
 */
export interface PromoRedemption {
	/** True when the redemption succeeded. */
	redeemed: boolean;

	/** 'subscribed' = new $0 subscription; 'credits_only' = already subscribed. */
	mode: 'subscribed' | 'credits_only';

	/** App the code targets. */
	appId: string;

	/** Subscription status after redemption (e.g. 'active'). */
	status?: string;

	/** Credits granted ({resource: amount}). */
	credits: Record<string, number>;
}

// =============================================================================
// CHECKOUT MODAL PROPS
// =============================================================================

/**
 * Promo-code callbacks — both or neither.
 *
 * The modal's grant-code path needs `onRedeemPromoCode` whenever
 * `onValidatePromoCode` resolves a hackathon code, so providing only one
 * of the pair is a misconfiguration; this union makes it a compile-time
 * error instead of a silent wrong-path fallback.
 */
export type CheckoutModalPromoProps =
	| {
		/**
		 * Resolves a promo code without side effects. Providing the pair
		 * renders a Promo Code box under the plan cards.
		 */
		onValidatePromoCode: (code: string, priceId?: string) => Promise<PromoValidation>;

		/**
		 * Redeems a credit-grant (hackathon) code — $0 subscription plus
		 * immediate credits, no plan selection or payment step.
		 */
		onRedeemPromoCode: (code: string) => Promise<PromoRedemption>;
	}
	| {
		onValidatePromoCode?: undefined;
		onRedeemPromoCode?: undefined;
	};

/**
 * Props for the host-agnostic CheckoutModal component.
 *
 * All server communication is delegated to the host via callbacks —
 * the component never imports the SDK or any transport layer directly.
 */
export interface CheckoutModalBaseProps {
	/** Display name of the app being subscribed to (e.g. "RocketRide"). */
	appName: string;

	/** Short description shown below the app name. */
	appDescription?: string;

	/** Stripe publishable key (pk_test_* or pk_live_*). */
	stripePublishableKey: string;

	/**
	 * When set, the modal skips the plan-picker step and goes straight to the
	 * payment step for this plan (creating the subscription immediately). Omit
	 * (the default) to show the picker first. Only the web pricing page sets
	 * this; the in-app and VS Code extension flows leave it undefined and keep
	 * the pick-a-plan → Continue UX.
	 */
	preselectedPlan?: CheckoutPlan;

	/** Fetches available subscription plans from the server. */
	onFetchPlans: () => Promise<CheckoutPlan[]>;

	/**
	 * Creates a Stripe subscription on the server and returns the
	 * client secret needed by Stripe Elements to confirm the payment.
	 *
	 * `clientSecret` is `null` when the first invoice is $0 (e.g. a 100%-off
	 * promotion code) — the subscription is already active and the payment
	 * step is skipped entirely.
	 */
	onCreateCheckout: (priceId: string, promotionCode?: string) => Promise<{ clientSecret: string | null; subscriptionId: string; status?: string }>;

	/**
	 * Notifies the server that payment was confirmed client-side.
	 * The server writes 'incomplete' status; the webhook later flips to 'active'.
	 */
	onConfirmPending: (subscriptionId: string, priceId: string) => Promise<void>;

	/** Called after a successful payment — host should close the modal. */
	onSuccess: () => void;

	/** Called when the user dismisses the modal without completing checkout. */
	onClose: () => void;

	/**
	 * Overrides how a plan's action CTA (Free → link, Enterprise → mailto) is
	 * opened. The browser default (window.open / mailto) works in the SaaS web
	 * app; the VS Code extension passes a handler that routes through the host,
	 * since webview navigation is sandboxed.
	 */
	onActionClick?: (plan: CheckoutPlan, action: PlanAction) => void;
}

/** Full CheckoutModal props: base props plus the paired promo callbacks. */
export type CheckoutModalProps = CheckoutModalBaseProps & CheckoutModalPromoProps;
