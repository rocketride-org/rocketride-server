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

import type { AppPrice } from 'shell';

/** Checkout replies from the host. */
export type CheckoutResultHostToWebview =
	| { type: 'checkout:plansResult'; plans: AppPrice[]; error: string | null }
	// clientSecret is null for a $0 first invoice (100%-off promo) — "no
	// payment step", not an error; `status` only travels on success.
	| { type: 'checkout:sessionResult'; clientSecret: string | null; subscriptionId: string; status?: string; error: string | null }
	| { type: 'checkout:confirmResult'; error: string | null };

/** Checkout requests from the webview. */
export type CheckoutRequestWebviewToHost =
	| { type: 'checkout:fetchPlans' }
	| { type: 'checkout:createSession'; priceId: string; promotionCode?: string }
	| { type: 'checkout:confirmPending'; subscriptionId: string; priceId: string };
