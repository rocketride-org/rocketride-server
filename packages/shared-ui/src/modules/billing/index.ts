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

// ── Sub-components ──────────────────────────────────────────────────────────
export { CreditsPanel } from './components/CreditsPanel';
export type { CreditsPanelProps } from './components/CreditsPanel';
export { BillingDashboard } from './components/BillingDashboard';
export type { BillingDashboardProps, ActiveTask, TopupPlan } from './components/BillingDashboard';
export { TopUpModal } from './components/TopUpModal';
export type { TopUpModalProps } from './components/TopUpModal';

// ── Types ───────────────────────────────────────────────────────────────────
export type { BillingDetail, StripePlan, CreditBalance, CreditPack, LedgerTransaction, TransactionsResult, UsageRollup } from './types';
