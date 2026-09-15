// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Embedded-Stripe checkout protocol — shared by the Account and Project
 * host/webview pairs (both render the Subscribe/checkout flow). View-specific
 * checkout messages (the Project gate pushes, the Account promo flow) live in
 * the owning view's protocol file, not here.
 *
 * Pure types only — imported by both the extension host and the webviews.
 */

import type { AppPrice } from 'rocketride';

/** Why a `checkout:stripeKey` reply carries no key — lets the webview explain
 *  the empty state (and the hook decide whether a retry can help) instead of a
 *  silently dead Subscribe click. Absent whenever `key` is non-empty.
 *  `no-billing` means the probe SUCCEEDED and the server simply has no
 *  billing configured (the OSS/standalone case) — terminal, never retried —
 *  while `no-connection`/`probe-failed` are transient and retryable. */
export type StripeKeyUnavailableReason = 'no-connection' | 'probe-failed' | 'no-billing';

/** Checkout replies from the host. */
export type CheckoutResultHostToWebview =
	| { type: 'checkout:plansResult'; plans: AppPrice[]; error: string | null }
	// clientSecret is null for a $0 first invoice (100%-off promo) — "no
	// payment step", not an error; `status` only travels on success.
	| { type: 'checkout:sessionResult'; clientSecret: string | null; subscriptionId: string; status?: string; error: string | null }
	| { type: 'checkout:confirmResult'; error: string | null }
	// Stripe publishable key of the server the host's billing client is
	// connected to ('' when unavailable, with `reason` explaining why).
	// Answered from the cached probe; consumed by useStripeKey, not the
	// webviews' main message switches. `requestId` echoes the request it
	// answers so the hook can drop a stale reply from a previous server
	// (a pre-switch reply that lands after a re-request).
	| { type: 'checkout:stripeKey'; key: string; requestId: number; reason?: StripeKeyUnavailableReason };

/** Checkout requests from the webview. */
export type CheckoutRequestWebviewToHost =
	| { type: 'checkout:fetchPlans' }
	| { type: 'checkout:createSession'; priceId: string; promotionCode?: string }
	| { type: 'checkout:confirmPending'; subscriptionId: string; priceId: string }
	// Sent by useStripeKey on mount (and on every re-request) wherever a
	// CheckoutModal can render. `requestId` is echoed in the reply so a stale
	// answer from a previous server can be ignored.
	| { type: 'checkout:getStripeKey'; requestId: number };
