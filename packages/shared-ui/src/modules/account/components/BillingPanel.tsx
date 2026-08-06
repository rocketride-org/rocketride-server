// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * BillingPanel — the Billing tab within AccountView.
 *
 * Renders compute credit balance with purchasable packs, followed by the
 * per-app subscriptions grid, then the admin billing dashboard.
 *
 * Subscriptions follow the record-panel standard (see ApiKeysPanel, THE
 * exemplar): the grid is PURE DATA — no Actions column — and every operation
 * on a subscription happens in ONE record surface, a contained DetailPanel
 * sliding from the Account dialog's edge:
 *
 *  - row click     -> the panel in VIEW mode (full plan / price / period
 *                     detail plus the credit-grant summary)
 *  - "Change Plan" -> the EXISTING UpgradeModal flow (flow modals remain
 *                     modals per the standard)
 *  - "Cancel Subscription" (footer, destructive) -> a stock ConfirmDialog,
 *                     then the RAW `onCancelSubscription` host action — the
 *                     panel owns loading / error state locally; no cancel
 *                     modal lives in AccountView anymore.
 */

import React, { useState, useCallback, useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { CellComponent } from 'tabulator-tables';
import { Card, Button, Banner, EmptyState, CardDataGrid, DetailPanel, ConfirmDialog, Section, LabelValue } from 'shell';
import type { GridColumnDefinition, IDataGridPageRequest } from 'shell';
import type { BillingDetail, CreditBalance, TransactionsResult, UsageRollup } from '../../billing/types';
import { CreditsPanel } from '../../billing/components/CreditsPanel';
import { BillingDashboard } from '../../billing/components/BillingDashboard';
import { TopUpModal } from '../../billing/components/TopUpModal';
import { UpgradeModal } from '../../billing/components/UpgradeModal';
import type { ActiveTask, TopupPlan } from '../../billing/components/BillingDashboard';
import type { CheckoutPlan } from '../../checkout/types';
import { Badge, parseWireDate } from './shared';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Vertical stack of the panel's cards (standard 16px rhythm). */
	stack: {
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	} as CSSProperties,

	/** Error banner text above the cards. */
	error: {
		color: 'var(--rr-color-error)',
		fontSize: 13,
		margin: 0,
	} as CSSProperties,

	/** Loading placeholder row inside the subscriptions card. */
	loadingRow: {
		padding: '20px 18px',
		color: 'var(--rr-text-disabled)',
		fontSize: 12,
	} as CSSProperties,

	/** Padded wrapper around the stock EmptyState (edge-to-edge card body). */
	emptyWrap: {
		padding: 16,
	} as CSSProperties,

	/** Credit grant summary block in the record panel body. */
	grants: {
		marginTop: 8,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.6,
	} as CSSProperties,

	/** Bold heading line within the grant summary. */
	grantHeading: {
		fontWeight: 600,
		marginTop: 4,
	} as CSSProperties,

	/** Indented grant line item. */
	grantItem: {
		paddingLeft: 12,
	} as CSSProperties,

	/** "Ends at period end" annotation next to the panel's status badge. */
	endsNote: {
		fontSize: 11,
		color: 'var(--rr-text-disabled)',
		marginLeft: 6,
	} as CSSProperties,

	/** Status badge shape for the grid formatter (shared Badge clone: commonStyles.badge values + surface fill); text color set per variant. */
	badge: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		padding: '2px 8px',
		fontSize: '11px',
		fontWeight: '600',
		borderRadius: '10px',
		letterSpacing: '0.3px',
		background: 'var(--rr-bg-surface-alt)',
	} as Partial<CSSStyleDeclaration>,

	/** Glowing green dot inside the 'active' badge (commonStyles.indicatorSuccess clone). */
	activeDot: {
		width: '8px',
		height: '8px',
		borderRadius: '50%',
		backgroundColor: 'var(--rr-color-success)',
		boxShadow: '0 0 4px var(--rr-color-success)',
	} as Partial<CSSStyleDeclaration>,

	/** Spacing wrapper for the in-panel error Banner at the top of the body. */
	errorBanner: {
		marginBottom: 12,
	} as CSSProperties,

	/** Left-anchored destructive slot in the panel footer (footer is flex-end). */
	footerDanger: {
		marginRight: 'auto',
	} as CSSProperties,

	/** Highlighted app name inside the cancel confirmation copy. */
	confirmName: {
		color: 'var(--rr-text-primary)',
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

/** Badge variant vocabulary shared by the status helpers and grid rows. */
type StatusBadgeVariant = 'active' | 'pending' | 'expired' | 'admin' | 'member';

/**
 * Returns a badge variant and label for a Stripe subscription status.
 *
 * @param status - Stripe status string (active, trialing, past_due, canceled).
 * @returns Object with badge variant and display label.
 */
function statusVariant(status: string): { variant: StatusBadgeVariant; label: string } {
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

/** Per-variant badge text colors — mirrors the shared Badge's overrides. */
const BADGE_COLORS: Record<StatusBadgeVariant, string> = {
	active: 'var(--rr-color-success)',
	pending: 'var(--rr-color-warning)',
	expired: 'var(--rr-color-error)',
	admin: 'var(--rr-brand)',
	member: 'var(--rr-text-secondary)',
};

/**
 * Builds a subscription-status badge for a grid cell (DOM clone of the
 * shared Badge component): surface fill, variant text color, and the
 * glowing green dot on 'active'.
 *
 * @param variant - Badge variant determining the text color.
 * @param label - Badge label text.
 * @returns The badge element.
 */
function statusBadgeEl(variant: StatusBadgeVariant, label: string): HTMLElement {
	const el = document.createElement('span');
	Object.assign(el.style, styles.badge);
	el.style.color = BADGE_COLORS[variant];
	// The active variant carries the glowing success dot before its label.
	if (variant === 'active') {
		const dot = document.createElement('span');
		Object.assign(dot.style, styles.activeDot);
		el.appendChild(dot);
	}
	el.appendChild(document.createTextNode(label));
	return el;
}

/**
 * Derives the credit-grant summary for a subscription (ported from the
 * retired row renderer): welcome-gift bonuses are `initial` minus the
 * `recurring` baseline — only positive differences show — plus the recurring
 * monthly grants themselves.
 *
 * @param credits - The subscription's credit grants config.
 * @returns Bonus and recurring line data, or null when there is nothing to show.
 */
function grantSummary(credits: BillingDetail['credits']): { bonuses: Array<{ res: string; diff: number }>; recurring: Record<string, number> | null } | null {
	if (!credits) return null;
	const recurring = credits.recurring ?? null;
	const initial = credits.initial;
	// Welcome gift = initial - recurring (bonus above baseline); hide if <= 0.
	const bonuses =
		initial && recurring
			? Object.entries(initial)
					.map(([res, amt]) => ({ res, diff: amt - (recurring[res] ?? 0) }))
					.filter(({ diff }) => diff > 0)
			: [];
	if (bonuses.length === 0 && !recurring) return null;
	return { bonuses, recurring };
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Flattened row shape fed to the subscriptions grid. Sortable / filterable
 * values are primitives; `plan`, `cycle`, and `status` are pre-computed
 * display strings so client-side sort and the enum filters operate on what
 * the user sees. `unitAmount` stays raw cents (the number filter needs the
 * true value; the formatter renders the dollars).
 */
interface SubRow extends Record<string, unknown> {
	/** App id — resolves the record for the panel on row click. */
	appId: string;
	/** Resolved app display name. */
	app: string;
	/** Plan nickname display string ('--' when the plan is unnamed). */
	plan: string;
	/** Raw plan price in USD cents, or null when unknown. */
	unitAmount: number | null;
	/** Raw Stripe billing interval ('month' / 'year'), read by the price formatter. */
	interval: string | null;
	/** Billing cycle display string (formatInterval). */
	cycle: string;
	/** ISO current-period-end timestamp, or null. */
	currentPeriodEnd: string | null;
	/** True when cancellation at period end is requested (drives the Renews/Ends wording). */
	cancelAtPeriodEnd: boolean;
	/** Status display label (from statusVariant). */
	status: string;
	/** Status badge variant paired with `status` (read by the badge formatter). */
	statusBadge: StatusBadgeVariant;
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
	/**
	 * Cancels a subscription at period end — the RAW server action. The record
	 * panel owns the confirmation (stock ConfirmDialog) and awaits this
	 * directly; the host just performs the cancel and refreshes the
	 * `subscriptions` prop.
	 */
	onCancelSubscription: (appId: string) => Promise<void>;
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
	/** Callback to change the transaction page (legacy prop bridge). */
	onTransactionPage?: (page: number) => void;
	/** Direct ledger query (preferred; see BillingDashboardProps). */
	fetchTransactions?: (req: IDataGridPageRequest) => Promise<TransactionsResult | null>;
	/** Org-scoped distinct ledger values for the enum checklist filters. */
	fetchTransactionDistinct?: (field: string) => Promise<(string | number | boolean)[]>;
	/** Available top-up packs. */
	topupPlans?: TopupPlan[];
	/** Callback when user clicks a top-up pack. */
	onBuyTopup?: (plan: TopupPlan) => void;
	/** All plans from app_prices (for the TopUpModal). */
	allPlans?: CheckoutPlan[];
	/** Called to purchase a top-up pack (charges card on file). */
	onPurchaseTopup?: (plan: CheckoutPlan) => Promise<{ status: string; clientSecret?: string }>;
	/** Called when the user confirms a plan change. */
	onUpgradeSubscription?: (appId: string, newPriceId: string) => Promise<void>;
}

// =============================================================================
// BILLING PANEL
// =============================================================================

/**
 * The Billing tab panel.
 *
 * Renders compute credits, the pure-data subscriptions grid plus its record
 * panel (view / change plan / cancel), and the admin dashboard. The cancel
 * confirmation and its error handling live HERE, not in AccountView.
 */
export const BillingPanel: React.FC<BillingPanelProps> = ({ isConnected, subscriptions, loading, error, creditBalance, onCancelSubscription, onOpenPortal, isOrgAdmin, onSubscribe, transactions, usageByUser, usageByTeam, activeTasks, dashboardLoading, onTransactionPage, fetchTransactions, fetchTransactionDistinct, topupPlans, onBuyTopup, allPlans, onPurchaseTopup, onUpgradeSubscription }) => {
	// ── Top-up modal state ──────────────────────────────────────────────────
	const [showTopUpModal, setShowTopUpModal] = useState(false);
	// ── Upgrade modal state ─────────────────────────────────────────────────
	const [upgradeTarget, setUpgradeTarget] = useState<BillingDetail | null>(null);
	// ── Record panel state ──────────────────────────────────────────────────
	// The open record's appId; the record itself resolves LIVE from props so a
	// host refresh (e.g. a cancel flipping cancelAtPeriodEnd) updates the open
	// panel in place.
	const [viewedAppId, setViewedAppId] = useState<string | null>(null);
	// Cancel confirmation gate (stacks over the panel via the overlay stack).
	const [confirmCancel, setConfirmCancel] = useState(false);
	// Async cancel lifecycle, owned locally like the exemplar record panels.
	const [cancelling, setCancelling] = useState(false);
	const [panelError, setPanelError] = useState<string | null>(null);
	const isSubscribed = subscriptions.length > 0;
	const handleAddCapacity = useCallback(() => setShowTopUpModal(true), []);

	// The viewed record resolves LIVE from the subscriptions prop by appId.
	const viewedSub = viewedAppId != null ? subscriptions.find((s) => s.appId === viewedAppId) ?? null : null;

	// ── Grid rows (flattened display-value primitives) ──────────────────────
	const rows = useMemo<SubRow[]>(
		() =>
			subscriptions.map((sub) => {
				// Pre-compute the status display pair once per row.
				const sv = statusVariant(sub.status);
				return {
					appId: sub.appId,
					app: sub.appName ?? sub.appId,
					plan: sub.planNickname ?? '--',
					unitAmount: sub.unitAmount,
					interval: sub.billingInterval,
					cycle: sub.billingInterval ? formatInterval(sub.billingInterval) : '--',
					currentPeriodEnd: sub.currentPeriodEnd,
					cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
					status: sv.label,
					statusBadge: sv.variant,
				};
			}),
		[subscriptions]
	);

	// ── Columns (pure data — the record panel replaced the row buttons) ─────
	// Contract flags (rrDefault, array order) declare the default layout; app asc keeps the short
	// subscriptions list alphabetical.
	const columns = useMemo<GridColumnDefinition[]>(
		() => [
			{ title: 'App', field: 'app', rrType: 'string', rrDefault: true, rrDefaultSort: 'asc', rrDescription: 'App-registry display name of the subscribed app; the raw app id stands in when no registry entry matches.', headerSort: true },
			{ title: 'Plan', field: 'plan', rrType: 'enum', rrDefault: true, rrDescription: 'Stripe price nickname of the subscribed plan; "--" when the price carries no nickname.', headerSort: true },
			{
				title: 'Price',
				field: 'unitAmount',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Recurring plan price. The raw value is Stripe unit_amount in USD cents — sorting and Min/Max filters operate on cents; the cell renders dollars per interval.',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				// Dollars + the raw interval from the row (sorting stays on cents).
				formatter: (cell: CellComponent) => {
					const cents = cell.getValue() as number | null;
					if (cents == null) return '--';
					const row = cell.getRow().getData() as SubRow;
					return row.interval ? `${formatUsd(cents)} / ${row.interval}` : formatUsd(cents);
				},
			},
			{ title: 'Billing Cycle', field: 'cycle', rrType: 'enum', rrDefault: true, rrDescription: 'How often the plan charges — the Stripe billing interval (month or year), shown as Monthly / Yearly.', headerSort: true },
			{
				title: 'Renews/Ends',
				field: 'currentPeriodEnd',
				rrType: 'date',
				rrDefault: true,
				rrDescription: 'End of the current Stripe billing period (UTC): the next renewal charge date, or the access-end date once cancellation at period end is requested.',
				headerSort: true,
				// parseWireDate applies the platform contract (zone-less wire
				// datetimes ARE UTC — a bare new Date(iso) would misparse them
				// as local); the wording follows cancelAtPeriodEnd.
				formatter: (cell: CellComponent) => {
					const iso = cell.getValue() as string | null;
					if (!iso) return '--';
					const row = cell.getRow().getData() as SubRow;
					return `${row.cancelAtPeriodEnd ? 'Cancels on' : 'Renews on'} ${parseWireDate(iso).toLocaleDateString()}`;
				},
			},
			{
				title: 'Status',
				field: 'status',
				rrType: 'enum',
				rrDefault: true,
				rrDescription: 'Stripe subscription status: Active, Trial (trialing), Past Due (last payment failed), or Canceled.',
				headerSort: true,
				// Badge formatter — DOM clone of the shared Badge component.
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as SubRow;
					return statusBadgeEl(row.statusBadge, cell.getValue() as string);
				},
			},
		],
		[]
	);

	// ── Record panel lifecycle ──────────────────────────────────────────────

	/** Close the record panel and drop every transient state it owned. */
	const closePanel = (): void => {
		setViewedAppId(null);
		setPanelError(null);
		setConfirmCancel(false);
	};

	/** Cancel the viewed subscription after the ConfirmDialog's confirmation. */
	const handleCancel = async (): Promise<void> => {
		if (!viewedSub) return;
		setCancelling(true);
		setPanelError(null);
		try {
			await onCancelSubscription(viewedSub.appId);
			setConfirmCancel(false);
			// Keep the panel open: the live record resolve shows the flipped
			// cancelAtPeriodEnd state as soon as the host refreshes props.
		} catch (e) {
			setConfirmCancel(false);
			setPanelError(e instanceof Error ? e.message : 'Failed to cancel subscription');
		} finally {
			setCancelling(false);
		}
	};

	// ── Render-derived record panel values ──────────────────────────────────
	// Footer verb gating mirrors the retired per-row buttons.
	const isCancelable = viewedSub != null && ['active', 'trialing', 'past_due'].includes(viewedSub.status) && !viewedSub.cancelAtPeriodEnd;
	// Status display pair and credit-grant summary for the open record.
	const viewedStatus = viewedSub != null ? statusVariant(viewedSub.status) : null;
	const grants = viewedSub != null ? grantSummary(viewedSub.credits) : null;

	return (
		<section style={styles.stack}>
			{/* Error banner */}
			{error && <p style={styles.error}>{error}</p>}

			{/* Credits panel (shown when connected) */}
			{isConnected && <CreditsPanel balance={creditBalance} packs={[]} onBuy={async () => {}} onAddCapacity={isSubscribed ? handleAddCapacity : undefined} />}

			{/* Subscriptions grid — pure data; row click opens the record panel.
			    The grid IS the card (headerless Card shell); the loading row and
			    the EmptyState branches keep their existing presentation. */}
			<Card noBodyPadding>
				{loading ? (
					<div style={styles.loadingRow}>Loading subscriptions…</div>
				) : subscriptions.length === 0 ? (
					<div style={styles.emptyWrap}>
						<EmptyState
							title="No active subscriptions"
							action={
								onSubscribe ? (
									<Button variant="primary" onClick={onSubscribe}>
										Subscribe to Pipe Builder
									</Button>
								) : undefined
							}
						/>
					</div>
				) : (
					<CardDataGrid<SubRow>
						title="Subscriptions"
						actions={
							isOrgAdmin ? (
								<Button variant="secondary" small onClick={onOpenPortal}>
									Manage Payment Methods {'→'}
								</Button>
							) : undefined
						}
						columns={columns}
						data={rows}
						noSearch
						onRowClick={(row) => {
							setPanelError(null);
							setViewedAppId(row.appId);
						}}
					/>
				)}
			</Card>

			{/* ── Record panel: VIEW mode (resolved LIVE from props). Footer
			    contract: [Cancel Subscription] left-anchored danger, [Change
			    Plan] (a flow-modal opener) in the right cluster; header X /
			    Escape are the exits — no footer Close. With neither verb the
			    panel is pure inspect (no footer). busy locks dismissal while
			    the cancel call is in flight. ─────────────────────────────── */}
			{viewedSub != null && viewedStatus != null && (
				<DetailPanel
					persistKey="panelDetailBillingWidth"
					contained
					open
					onClose={closePanel}
					title={viewedSub.appName ?? viewedSub.appId}
					subtitle={viewedStatus.label}
					busy={cancelling}
					footer={
						// Footer shows for an org admin when EITHER verb is available; the
						// Cancel button is gated on isCancelable independently, so a sub
						// already set to cancel-at-period-end still offers Change Plan.
						isOrgAdmin && (isCancelable || onUpgradeSubscription) ? (
							<>
								{isCancelable && (
									<div style={styles.footerDanger}>
										<Button variant="danger" small disabled={cancelling} onClick={() => setConfirmCancel(true)}>
											Cancel Subscription
										</Button>
									</div>
								)}
								{onUpgradeSubscription && (
									<Button variant="ghost" small disabled={cancelling} onClick={() => setUpgradeTarget(viewedSub)}>
										Change Plan
									</Button>
								)}
							</>
						) : undefined
					}
				>
					{/* In-panel error surface (interaction standard): a stock Banner
					    at the top of the body. */}
					{panelError && (
						<div style={styles.errorBanner}>
							<Banner variant="error">{panelError}</Banner>
						</div>
					)}
					{/* Full subscription detail (the retired row's detail grid). */}
					<Section label="Subscription">
						<LabelValue label="Plan">{viewedSub.planNickname ?? '--'}</LabelValue>
						<LabelValue label="Price">{viewedSub.unitAmount != null ? `${formatUsd(viewedSub.unitAmount)}${viewedSub.billingInterval ? ` / ${viewedSub.billingInterval}` : ''}` : '--'}</LabelValue>
						<LabelValue label="Billing Cycle">{viewedSub.billingInterval ? formatInterval(viewedSub.billingInterval) : '--'}</LabelValue>
						<LabelValue label="Period Start">{viewedSub.currentPeriodStart ? parseWireDate(viewedSub.currentPeriodStart).toLocaleDateString() : '--'}</LabelValue>
						<LabelValue label="Period End">{viewedSub.currentPeriodEnd ? parseWireDate(viewedSub.currentPeriodEnd).toLocaleDateString() : '--'}</LabelValue>
						<LabelValue label="Status">
							<Badge variant={viewedStatus.variant}>{viewedStatus.label}</Badge>
							{viewedSub.cancelAtPeriodEnd && <span style={styles.endsNote}>Ends at period end</span>}
						</LabelValue>
					</Section>

					{/* Credit grant summary (ported from the retired row renderer). */}
					{grants != null && (
						<Section label="Included Credits">
							<div style={styles.grants}>
								{/* Welcome-gift bonuses (initial above the recurring baseline). */}
								{grants.bonuses.length > 0 && (
									<>
										<div style={styles.grantHeading}>As a Welcome gift</div>
										{grants.bonuses.map(({ res, diff }) => (
											<div key={`bonus-${res}`} style={styles.grantItem}>
												{formatGrant(res, diff, viewedSub.labels)} bonus
											</div>
										))}
									</>
								)}
								{/* Recurring monthly grants. */}
								{grants.recurring != null && (
									<>
										<div style={styles.grantHeading}>Monthly</div>
										{Object.entries(grants.recurring).map(([res, amt]) => (
											<div key={`rec-${res}`} style={styles.grantItem}>
												{formatGrant(res, amt, viewedSub.labels)}
											</div>
										))}
									</>
								)}
							</div>
						</Section>
					)}
				</DetailPanel>
			)}

			{/* ── Cancel confirmation (stacks over the record panel) ─────────── */}
			{confirmCancel && viewedSub != null && (
				<ConfirmDialog
					title="Cancel Subscription"
					destructive
					confirmLabel={cancelling ? 'Cancelling…' : 'Yes, Cancel'}
					cancelLabel="Keep Subscription"
					confirmDisabled={cancelling}
					message={
						<>
							Are you sure you want to cancel <strong style={styles.confirmName}>{viewedSub.appName ?? viewedSub.appId}</strong>? Your access will continue until
							the end of the current billing period, after which the subscription will not renew.
						</>
					}
					onConfirm={() => void handleCancel()}
					onCancel={() => setConfirmCancel(false)}
				/>
			)}

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
					fetchTransactions={fetchTransactions}
					fetchTransactionDistinct={fetchTransactionDistinct}
					onBuyTopup={onBuyTopup}
					onAddCapacity={isSubscribed ? handleAddCapacity : undefined}
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
