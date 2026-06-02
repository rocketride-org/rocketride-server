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
 * Plans come from Stripe via the server's ``prices`` subcommand.
 * The ``action`` field (from Stripe price metadata) determines what
 * happens when the user clicks the card — checkout or navigate away.
 */
export interface CheckoutPlan {
	/** Stripe price_* identifier. Passed to the checkout session creation. */
	priceId: string;

	/** Human-readable label shown in the plan selector (e.g. "Monthly", "Annual"). */
	label: string;

	/** Billing interval — used for the toggle and to group plans. */
	interval: 'month' | 'year' | '';

	/** Display price string (e.g. "$29 / mo", "$276 / yr", "Free", "Custom"). */
	amount: string;

	/** Feature description lines from Stripe price metadata, displayed on the plan card. */
	description?: string[] | null;

	/**
	 * Alternative click action. When present, clicking the card opens
	 * a link or mailto instead of proceeding to Stripe checkout.
	 * Plans without an action go through the normal checkout flow.
	 */
	action?: PlanAction | null;

	/**
	 * Sort order for card positioning.  Lower values appear first.
	 * Spaced 100 apart by convention (Free=100, Starter=200, …, Enterprise=900).
	 * Defaults to 500 when not set in Stripe metadata.
	 */
	order?: number;

	/** Credit grants config from Stripe price metadata, or null. */
	credits?: { initial?: Record<string, number>; recurring?: Record<string, number> } | null;

	/** Display templates for credit resource types (e.g. ``{amount} minutes of Audio``), or null. */
	creditLabels?: Record<string, string> | null;
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
}
