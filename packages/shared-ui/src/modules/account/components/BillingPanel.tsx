// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * BillingPanel — the Billing tab within AccountView.
 *
 * Renders compute credit balance with purchasable packs, followed by
 * per-app subscription rows in a standard card layout. The cancel
 * confirmation dialog and portal error handling are owned by AccountView
 * via callback props.
 *
 * Uses the same card/header/rowList pattern as MembersPanel and TeamsPanel
 * for visual consistency across account tabs.
 */

import React, { useState, useCallback, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';
import type { BillingDetail, CreditBalance, TransactionsResult, UsageRollup } from '../../billing/types';
import { CreditsPanel } from '../../billing/components/CreditsPanel';
import { BillingDashboard } from '../../billing/components/BillingDashboard';
import { TopUpModal } from '../../billing/components/TopUpModal';
import { UpgradeModal } from '../../billing/components/UpgradeModal';
import type { ActiveTask, TopupPlan } from '../../billing/components/BillingDashboard';
import type { CheckoutPlan } from '../../checkout/types';
import { S as SharedS, Badge } from './shared';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	/** Renewal / cancellation date line. */
	meta: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		marginTop: 2,
	} as CSSProperties,

	/** Detail row inside a subscription row (label + value pairs). */
	detailGrid: {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '4px 20px',
		marginTop: 8,
		fontSize: 12,
	} as CSSProperties,

	/** Detail label (left column). */
	detailLabel: {
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Detail value (right column). */
	detailValue: {
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		textAlign: 'right' as const,
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Converts USD cents to a display string (e.g. 2900 → "$29.00").
 *
 * @param cents - Price in USD cents.
 * @returns Formatted dollar string.
 */
function formatUsd(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Formats a billing interval string for display (e.g. "month" → "Monthly").
 *
 * @param interval - Stripe billing interval string.
 * @returns Human-readable interval label.
 */
function formatInterval(interval: string): string {
	switch (interval) {
		case 'month':
			return 'Monthly';
		case 'year':
			return 'Yearly';
		default:
			return interval;
	}
}

/**
 * Formats a credit grant line using the label template from Stripe metadata.
 * Replaces ``{amount}`` with the localized number. Falls back to raw key.
 */
function formatGrant(resource: string, amount: number, labels: Record<string, string> | null | undefined): string {
	const template = labels?.[resource];
	if (template) return template.replace('{amount}', amount.toLocaleString());
	return `${amount.toLocaleString()} ${resource}`;
}

/**
 * Returns a badge variant and label for a Stripe subscription status.
 *
 * @param status - Stripe status string (active, trialing, past_due, canceled).
 * @returns Object with badge variant and display label.
 */
function statusVariant(status: string): { variant: 'active' | 'pending' | 'expired' | 'admin' | 'member'; label: string } {
	switch (status) {
		case 'active':
			return { variant: 'active', label: 'Active' };
		case 'trialing':
			return { variant: 'pending', label: 'Trial' };
		case 'past_due':
			return { variant: 'expired', label: 'Past Due' };
		case 'canceled':
			return { variant: 'expired', label: 'Canceled' };
		default:
			return { variant: 'member', label: status };
	}
}

// =============================================================================
// PROPS
// =============================================================================

/** Props accepted by the BillingPanel component. */
export interface BillingPanelProps {
	/** Whether the host connection is active. */
	isConnected: boolean;
	/** Per-app subscription rows. */
	subscriptions: BillingDetail[];
	/** True while initial data is being fetched. */
	loading: boolean;
	/** Error message from the last failed operation, or null. */
	error: string | null;
	/** Current org credit balance, or null while loading. */
	creditBalance: CreditBalance | null;
	/** Available credit packs for purchase. */
	/** Called when the user clicks Cancel on a subscription. Opens the modal in AccountView. */
	onCancelSubscription: (appId: string) => void;
	/** Open the Stripe customer portal for payment management. */
	onOpenPortal: () => void;
	/** True when the current user has org.admin permissions. */
	isOrgAdmin: boolean;
	/** App manifest entries for resolving display names, icons, etc. from appId. */
	apps?: Array<{ id: string; name: string; icon?: string; description?: string }>;
	/** Called when the user clicks the Subscribe CTA. Opens the checkout flow. */
	onSubscribe?: () => void;

	// ── Dashboard data (admin insights) ─────────────────────────────────────
	/** Paginated transaction result for the transaction log. */
	transactions?: TransactionsResult | null;
	/** Per-user usage rollup. */
	usageByUser?: UsageRollup[];
	/** Per-team usage rollup. */
	usageByTeam?: UsageRollup[];
	/** Currently running tasks with live token data. */
	activeTasks?: ActiveTask[];
	/** Whether dashboard data is still loading. */
	dashboardLoading?: boolean;
	/** Callback to change the transaction page. */
	onTransactionPage?: (page: number) => void;
	/** Available top-up packs. */
	topupPlans?: TopupPlan[];
	/** Callback when user clicks a top-up pack. */
	onBuyTopup?: (plan: TopupPlan) => void;
	/** All plans from app_prices (for the TopUpModal). */
	allPlans?: CheckoutPlan[];
	/** Called to purchase a top-up pack (charges card on file). */
	onPurchaseTopup?: (plan: CheckoutPlan) => Promise<{ status: string; clientSecret?: string }>;
	/** Member lookup: userId -> display name. */
	memberNames?: Record<string, string>;
	/** Team lookup: teamId -> display name. */
	teamNames?: Record<string, string>;
	/** Called when the user confirms a plan change. */
	onUpgradeSubscription?: (appId: string, newPriceId: string) => Promise<void>;
}

// =============================================================================
// BILLING PANEL
// =============================================================================

/**
 * The Billing tab panel.
 *
 * Renders compute credits and subscription rows using the standard card
 * pattern. The cancel confirmation dialog is owned by AccountView.
 */
export const BillingPanel: React.FC<BillingPanelProps> = ({ isConnected, subscriptions, loading, error, creditBalance, apps, onCancelSubscription, onOpenPortal, isOrgAdmin, onSubscribe, transactions, usageByUser, usageByTeam, activeTasks, dashboardLoading, onTransactionPage, topupPlans, onBuyTopup, allPlans, onPurchaseTopup, memberNames, teamNames, onUpgradeSubscription }) => {
	// ── Top-up modal state ──────────────────────────────────────────────────
	const [showTopUpModal, setShowTopUpModal] = useState(false);
	// ── Upgrade modal state ─────────────────────────────────────────────────
	const [upgradeTarget, setUpgradeTarget] = useState<BillingDetail | null>(null);
	const isSubscribed = subscriptions.length > 0;
	const handleAddCapacity = useCallback(() => setShowTopUpModal(true), []);
	// Build appId → app lookup for display name resolution
	const appMap = useMemo(() => {
		const map: Record<string, { id: string; name: string; icon?: string; description?: string }> = {};
		for (const a of apps ?? []) map[a.id] = a;
		return map;
	}, [apps]);
	return (
		<section>
			{/* Error banner */}
			{error && <p style={{ color: 'var(--rr-color-error)', fontSize: 13, marginBottom: 12 }}>{error}</p>}

			{/* Credits panel (shown when connected) */}
			{isConnected && <CreditsPanel balance={creditBalance} packs={[]} onBuy={async () => {}} onAddCapacity={isSubscribed ? handleAddCapacity : undefined} />}

			{/* Subscriptions card */}
			<div style={{ ...commonStyles.card, marginTop: 16, marginBottom: 14 }}>
				<div style={commonStyles.cardHeader}>
					<span style={commonStyles.labelUppercase}>
						{subscriptions.length} subscription{subscriptions.length !== 1 ? 's' : ''}
					</span>
					{isOrgAdmin && (
						<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardHeaderButton } as CSSProperties} onClick={onOpenPortal}>
							Manage Payment Methods →
						</button>
					)}
				</div>
				<div style={SharedS.rowList}>
					{loading ? (
						<div style={{ padding: '20px 18px', color: 'var(--rr-text-disabled)', fontSize: 12 }}>Loading subscriptions…</div>
					) : subscriptions.length === 0 ? (
						<div style={{ padding: '20px 18px' }}>
							<p style={{ color: 'var(--rr-text-disabled)', fontSize: 12, margin: '0 0 12px 0' }}>No active subscriptions.</p>
							{onSubscribe && (
								<button style={commonStyles.buttonPrimary as CSSProperties} onClick={onSubscribe}>
									Subscribe to Pipe Builder
								</button>
							)}
						</div>
					) : (
						subscriptions.map((sub, i) => {
							const sv = statusVariant(sub.status);
							const isCancelable = ['active', 'trialing', 'past_due'].includes(sub.status) && !sub.cancelAtPeriodEnd;

							return (
								<div key={sub.appId} style={{ ...SharedS.rowItem, borderBottom: i < subscriptions.length - 1 ? '1px solid var(--rr-border)' : 'none', alignItems: 'flex-start' }}>
									<div style={SharedS.rowInfo}>
										{/* App name + renewal info */}
										<div style={SharedS.rowName}>{appMap[sub.appId]?.name ?? sub.appId}</div>
										{sub.currentPeriodEnd && <div style={S.meta}>{sub.cancelAtPeriodEnd ? `Cancels on ${new Date(sub.currentPeriodEnd).toLocaleDateString()}` : `Renews on ${new Date(sub.currentPeriodEnd).toLocaleDateString()}`}</div>}

										{/* Subscription detail grid */}
										<div style={S.detailGrid}>
											{sub.planNickname && (
												<>
													<span style={S.detailLabel}>Plan</span>
													<span style={S.detailValue}>{sub.planNickname}</span>
												</>
											)}
											{sub.unitAmount != null && sub.billingInterval && (
												<>
													<span style={S.detailLabel}>Price</span>
													<span style={S.detailValue}>
														{formatUsd(sub.unitAmount)} / {sub.billingInterval}
													</span>
												</>
											)}
											{sub.billingInterval && (
												<>
													<span style={S.detailLabel}>Billing Cycle</span>
													<span style={S.detailValue}>{formatInterval(sub.billingInterval)}</span>
												</>
											)}
											{sub.currentPeriodStart && (
												<>
													<span style={S.detailLabel}>Period Start</span>
													<span style={S.detailValue}>{new Date(sub.currentPeriodStart).toLocaleDateString()}</span>
												</>
											)}
											{sub.currentPeriodEnd && (
												<>
													<span style={S.detailLabel}>Period End</span>
													<span style={S.detailValue}>{new Date(sub.currentPeriodEnd).toLocaleDateString()}</span>
												</>
											)}
										</div>

										{/* Credit grant summary */}
										{sub.credits && (() => {
											const recurring = sub.credits!.recurring;
											const initial = sub.credits!.initial;
											// Welcome gift = initial - recurring (bonus above baseline); hide if <= 0
											const bonuses = initial && recurring
												? Object.entries(initial)
													.map(([res, amt]) => ({ res, diff: amt - (recurring[res] ?? 0) }))
													.filter(({ diff }) => diff > 0)
												: [];
											return (
												<div style={{ marginTop: 8, fontSize: 12, color: 'var(--rr-text-secondary)', lineHeight: 1.6 }}>
													{bonuses.length > 0 && (
														<>
															<div style={{ fontWeight: 600, marginTop: 4 }}>As a Welcome gift</div>
															{bonuses.map(({ res, diff }) => (
																<div key={`bonus-${res}`} style={{ paddingLeft: 12 }}>{formatGrant(res, diff, sub.creditLabels)} bonus</div>
															))}
														</>
													)}
													{recurring && (
														<>
															<div style={{ fontWeight: 600, marginTop: 4 }}>Monthly</div>
															{Object.entries(recurring).map(([res, amt]) => (
																<div key={`rec-${res}`} style={{ paddingLeft: 12 }}>{formatGrant(res, amt, sub.creditLabels)}</div>
															))}
														</>
													)}
												</div>
											);
										})()}
									</div>

									{/* Status badge + actions */}
									<div style={SharedS.rowActions}>
										<Badge variant={sv.variant}>{sv.label}</Badge>
										{isCancelable && isOrgAdmin && onUpgradeSubscription && (
											<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton } as CSSProperties} onClick={() => setUpgradeTarget(sub)}>
												Change Plan
											</button>
										)}
										{isCancelable && isOrgAdmin && (
											<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton } as CSSProperties} onClick={() => onCancelSubscription(sub.appId)}>
												Cancel
											</button>
										)}
										{sub.cancelAtPeriodEnd && <span style={{ fontSize: 11, color: 'var(--rr-text-disabled)' }}>Ends at period end</span>}
									</div>
								</div>
							);
						})
					)}
				</div>
			</div>

			{/* Admin billing dashboard */}
			{isOrgAdmin && isConnected && (
				<BillingDashboard
					balance={creditBalance}
					transactions={transactions ?? null}
					usageByUser={usageByUser ?? []}
					usageByTeam={usageByTeam ?? []}
					activeTasks={activeTasks ?? []}
					topupPlans={topupPlans ?? []}
					loading={dashboardLoading ?? false}
					onTransactionPage={onTransactionPage ?? (() => {})}
					onBuyTopup={onBuyTopup}
					onAddCapacity={isSubscribed ? handleAddCapacity : undefined}
					memberNames={memberNames}
					teamNames={teamNames}
				/>
			)}

			{/* Top-up modal */}
			{showTopUpModal && allPlans && onPurchaseTopup && (
				<TopUpModal
					plans={allPlans}
					onPurchase={onPurchaseTopup}
					onClose={() => setShowTopUpModal(false)}
				/>
			)}

			{/* Upgrade / change plan modal */}
			{upgradeTarget && allPlans && onUpgradeSubscription && (
				<UpgradeModal
					plans={allPlans.filter((p) => p.appId === upgradeTarget.appId)}
					currentPriceId={upgradeTarget.stripePriceId}
					currentPlanName={upgradeTarget.planNickname}
					onUpgrade={(newPriceId) => onUpgradeSubscription(upgradeTarget.appId, newPriceId)}
					onClose={() => setUpgradeTarget(null)}
				/>
			)}
		</section>
	);
};
