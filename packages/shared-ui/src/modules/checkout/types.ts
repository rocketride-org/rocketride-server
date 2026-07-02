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
// CHECKOUT MODAL PROPS
// =============================================================================

/**
 * Props for the host-agnostic CheckoutModal component.
 *
 * All server communication is delegated to the host via callbacks —
 * the component never imports the SDK or any transport layer directly.
 */
export interface CheckoutModalProps {
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
	 */
	onCreateCheckout: (priceId: string) => Promise<{ clientSecret: string; subscriptionId: string }>;

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
