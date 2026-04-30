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
// CHECKOUT PLAN
// =============================================================================

/**
 * A single subscription plan shown in the CheckoutModal plan picker.
 * Returned by the server's `prices` subcommand with pre-formatted display strings.
 */
export interface CheckoutPlan {
	/** Stripe price_* identifier. Passed to the checkout session creation. */
	priceId: string;

	/** Human-readable label shown in the plan selector (e.g. "Monthly", "Annual"). */
	label: string;

	/** Billing interval — used to sort and badge the options. */
	interval: 'month' | 'year';

	/** Display price string (e.g. "$29 / mo", "$276 / yr"). */
	amount: string;
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

	/** Short description shown below the app name in the left column. */
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
