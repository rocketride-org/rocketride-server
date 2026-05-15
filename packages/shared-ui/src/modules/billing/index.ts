// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Billing module — subscription management, compute credits, and Stripe API.
 *
 * Exports the pure BillingView component (props-in, callbacks-out),
 * the billingApi DAP wrappers, and all related types.
 */

// ── View ────────────────────────────────────────────────────────────────────
export { default as BillingView } from './BillingView';
export type { IBillingViewProps } from './BillingView';

// ── Sub-components ──────────────────────────────────────────────────────────
export { CreditsPanel } from './components/CreditsPanel';
export type { CreditsPanelProps } from './components/CreditsPanel';

// ── Types ───────────────────────────────────────────────────────────────────
export type { BillingDetail, StripePlan, CreditBalance, CreditPack } from './types';
