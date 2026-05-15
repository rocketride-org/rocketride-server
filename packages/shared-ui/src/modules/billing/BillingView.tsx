// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * BillingView — pure subscription and payment management view.
 *
 * Displays per-app subscription cards with status badges, renewal info,
 * and cancel actions. Includes a CreditsPanel for compute credit balance
 * and top-up purchases.
 *
 * This component is host-agnostic: all data is received as props and all
 * mutations are delegated via async callbacks. The host (shell-ui or
 * VS Code) is responsible for fetching data and executing API calls.
 */

import React, { useState, useCallback, useMemo, type CSSProperties } from 'react';
import { commonStyles } from '../../themes/styles';
import type { BillingDetail, CreditBalance, CreditPack } from './types';
import { CreditsPanel } from './components/CreditsPanel';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	/** Root container — centered column with max width. */
	container: {
		padding: 32,
		maxWidth: 720,
		margin: '0 auto',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	/** Page heading. */
	heading: {
		fontSize: 22,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		marginBottom: 4,
	} as CSSProperties,

	/** Page subtitle under the heading. */
	subtitle: {
		fontSize: 14,
		color: 'var(--rr-text-secondary)',
		marginBottom: 28,
	} as CSSProperties,

	/** Subscription card. */
	card: {
		...commonStyles.card,
		padding: 24,
		marginBottom: 16,
	} as CSSProperties,

	/** Top row of a subscription card (name + badge). */
	row: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 16,
	} as CSSProperties,

	/** App name in the subscription card. */
	appName: {
		fontSize: 17,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	/** Renewal / cancellation date line. */
	meta: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		marginTop: 6,
	} as CSSProperties,

	/** Action buttons row. */
	actions: {
		display: 'flex',
		gap: 10,
		marginTop: 16,
		flexWrap: 'wrap' as const,
	} as CSSProperties,

	/** Inline status badge pill. */
	badge: (color: string, bg: string): CSSProperties => ({
		display: 'inline-block',
		marginLeft: 10,
		padding: '2px 10px',
		fontSize: 11,
		fontWeight: 600,
		borderRadius: 12,
		background: bg,
		color,
	}),

	/** Error message. */
	error: {
		color: 'var(--rr-color-error)',
		fontSize: 13,
		marginTop: 8,
	} as CSSProperties,

	/** Empty-state or loading placeholder. */
	empty: {
		textAlign: 'center' as const,
		color: 'var(--rr-text-secondary)',
		padding: '48px 0',
		fontSize: 15,
	} as CSSProperties,

	/** Cancellation note text. */
	cancelNote: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		alignSelf: 'center',
	} as CSSProperties,

	/** Portal link row at the bottom. */
	portalRow: {
		marginTop: 8,
		textAlign: 'right' as const,
	} as CSSProperties,

	/** Section label between credits panel and subscription list. */
	sectionLabel: {
		fontSize: 11,
		fontWeight: 600,
		textTransform: 'uppercase' as const,
		letterSpacing: '0.5px',
		color: 'var(--rr-text-secondary)',
		marginTop: 28,
		marginBottom: 12,
	} as CSSProperties,

	/** Detail row inside a subscription card (label + value pairs). */
	detailGrid: {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '6px 24px',
		marginTop: 12,
	} as CSSProperties,

	/** Detail label (left column). */
	detailLabel: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Detail value (right column). */
	detailValue: {
		fontSize: 12,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		textAlign: 'right' as const,
	} as CSSProperties,

	/** Confirmation dialog content box. */
	confirmDialog: {
		...commonStyles.dialog,
		width: 420,
		padding: 24,
	} as CSSProperties,

	/** Confirmation dialog title. */
	confirmTitle: {
		fontSize: 16,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		marginBottom: 8,
	} as CSSProperties,

	/** Confirmation dialog body text. */
	confirmBody: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		marginBottom: 20,
		lineHeight: 1.5,
	} as CSSProperties,

	/** Confirmation dialog button row. */
	confirmActions: {
		display: 'flex',
		justifyContent: 'flex-end',
		gap: 10,
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Converts USD cents to a display string (e.g. 2900 → "$29.00", 1599 → "$15.99").
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
 * Returns a human-readable label and colour for a Stripe subscription status.
 *
 * @param status - Stripe status string (active, trialing, past_due, canceled).
 * @returns Object with display label, text color, and background color.
 */
function statusBadge(status: string): { label: string; color: string; bg: string } {
	const bg = 'var(--rr-bg-surface-alt)';
	switch (status) {
		case 'active':
			return { label: 'Active', color: 'var(--rr-color-success)', bg };
		case 'trialing':
			return { label: 'Trial', color: 'var(--rr-color-info)', bg };
		case 'past_due':
			return { label: 'Past Due', color: 'var(--rr-color-warning)', bg };
		case 'canceled':
			return { label: 'Canceled', color: 'var(--rr-color-error)', bg };
		default:
			return { label: status, color: 'var(--rr-text-secondary)', bg };
	}
}

// =============================================================================
// PROPS
// =============================================================================

/** Props for the pure BillingView component. */
export interface IBillingViewProps {
	/** Whether the host connection is active. */
	isConnected: boolean;
	/** Per-app subscription rows. */
	subscriptions: BillingDetail[];
	/** True while initial data is being fetched. */
	loading: boolean;
	/** Error message from the last failed operation, or null. */
	error: string | null;

	// ── Credits ─────────────────────────────────────────────────────────────
	/** Current org credit balance, or null while loading. */
	creditBalance: CreditBalance | null;
	/** Available credit packs for purchase. */
	creditPacks: CreditPack[];

	// ── Callbacks ────────────────────────────────────────────────────────────
	/** Cancel a subscription. Host re-fetches and updates subscriptions prop. */
	onCancelSubscription: (appId: string) => Promise<void>;
	/** Open the Stripe customer portal for payment management. */
	onOpenPortal: () => Promise<void>;
	/** Purchase a credit pack. Host handles Stripe checkout redirect/URL. */
	onBuyCredits: (pack: CreditPack) => Promise<void>;
	/** App manifest entries for resolving display names, icons, etc. from appId. */
	apps?: Array<{ id: string; name: string; icon?: string; description?: string }>;
}

// =============================================================================
// COMPONENT
// =============================================================================

/** Pure subscription and payment management view. */
const BillingView: React.FC<IBillingViewProps> = ({ isConnected, subscriptions, loading, error: externalError, creditBalance, creditPacks, onCancelSubscription, onOpenPortal, onBuyCredits, apps }) => {
	// Build appId → app lookup for display name resolution
	const appMap = useMemo(() => {
		const map: Record<string, { name: string; icon?: string; description?: string }> = {};
		for (const a of apps ?? []) map[a.id] = a;
		return map;
	}, [apps]);
	// ── Local action error state ────────────────────────────────────────────
	const [actionError, setActionError] = useState<string | null>(null);
	const displayError = actionError || externalError;

	// ── Cancel confirmation state ───────────────────────────────────────────
	const [confirmAppId, setConfirmAppId] = useState<string | null>(null);
	const [cancelling, setCancelling] = useState(false);

	/** Opens the cancel confirmation dialog. */
	const requestCancel = useCallback((appId: string) => {
		setConfirmAppId(appId);
	}, []);

	/** Closes the cancel confirmation dialog without acting. */
	const dismissCancel = useCallback(() => {
		if (!cancelling) setConfirmAppId(null);
	}, [cancelling]);

	/** Confirms the cancellation and delegates to the host callback. */
	const confirmCancel = useCallback(async () => {
		if (!confirmAppId) return;
		setActionError(null);
		setCancelling(true);
		try {
			await onCancelSubscription(confirmAppId);
			setConfirmAppId(null);
		} catch (err: any) {
			setActionError(err.message ?? 'Failed to cancel subscription');
		} finally {
			setCancelling(false);
		}
	}, [confirmAppId, onCancelSubscription]);

	/** Wraps the portal callback with local error handling. */
	const handlePortal = async () => {
		setActionError(null);
		try {
			await onOpenPortal();
		} catch (err: any) {
			setActionError(err.message ?? 'Failed to open billing portal');
		}
	};

	// ── Render ──────────────────────────────────────────────────────────────
	return (
		<div style={S.container}>
			<div style={S.heading}>Billing</div>
			<p style={S.subtitle}>Manage your app subscriptions and payment methods.</p>

			{/* Error banner */}
			{displayError && <p style={S.error}>{displayError}</p>}

			{/* Credits panel (shown when connected) */}
			{isConnected && <CreditsPanel balance={creditBalance} packs={creditPacks} onBuy={onBuyCredits} />}

			{/* Subscription list */}
			{loading ? (
				<p style={S.empty}>Loading subscriptions…</p>
			) : subscriptions.length === 0 ? (
				<p style={S.empty}>No active subscriptions. Subscribe to an app from the app store.</p>
			) : (
				<>
					{/* Section separator between credits and subscriptions */}
					<div style={S.sectionLabel}>Subscriptions</div>

					{subscriptions.map((sub) => {
						const badge = statusBadge(sub.status);
						const isCancelable = ['active', 'trialing', 'past_due'].includes(sub.status) && !sub.cancelAtPeriodEnd;

						return (
							<div key={sub.appId} style={S.card}>
								{/* App name + status badge */}
								<div style={S.row}>
									<div>
										<div style={S.appName}>
											{appMap[sub.appId]?.name ?? sub.appId}
											<span style={S.badge(badge.color, badge.bg)}>{badge.label}</span>
										</div>
										{/* Renewal / cancellation date */}
										{sub.currentPeriodEnd && <div style={S.meta}>{sub.cancelAtPeriodEnd ? `Cancels on ${new Date(sub.currentPeriodEnd).toLocaleDateString()}` : `Renews on ${new Date(sub.currentPeriodEnd).toLocaleDateString()}`}</div>}
									</div>
								</div>

								{/* Subscription details grid */}
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

								{/* Action buttons */}
								<div style={S.actions}>
									{isCancelable && (
										<button style={{ ...commonStyles.buttonDangerOutline, ...commonStyles.cardBodyButton } as CSSProperties} onClick={() => requestCancel(sub.appId)}>
											Cancel Subscription
										</button>
									)}
									{sub.cancelAtPeriodEnd && <span style={S.cancelNote}>Access ends at period end</span>}
								</div>
							</div>
						);
					})}

					{/* Stripe customer portal link */}
					<div style={S.portalRow}>
						<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton } as CSSProperties} onClick={handlePortal}>
							Manage Payment Methods →
						</button>
					</div>
				</>
			)}

			{/* ── Cancel confirmation dialog ──────────────────────────────────── */}
			{confirmAppId && (
				<div style={commonStyles.modalOverlay as CSSProperties} onClick={dismissCancel}>
					<div style={S.confirmDialog} onClick={(e) => e.stopPropagation()}>
						<div style={S.confirmTitle}>Cancel Subscription</div>
						<div style={S.confirmBody}>
							Are you sure you want to cancel <strong>{appMap[confirmAppId!]?.name ?? confirmAppId}</strong>? Your access will continue until the end of the current billing period, after which the subscription will not renew.
						</div>
						<div style={S.confirmActions}>
							<button style={commonStyles.buttonSecondary as CSSProperties} onClick={dismissCancel} disabled={cancelling}>
								Keep Subscription
							</button>
							<button style={{ ...commonStyles.buttonDanger, ...(cancelling ? commonStyles.buttonDisabled : {}) } as CSSProperties} onClick={confirmCancel} disabled={cancelling}>
								{cancelling ? 'Cancelling…' : 'Yes, Cancel'}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
};

export default BillingView;
