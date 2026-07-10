// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * BillingDashboard -- admin billing insights rendered below the credits panel.
 *
 * Five sections, each a stock Card:
 *   1. Balance breakdown -- purchased vs consumed per resource with bars
 *   2. Spending velocity -- burn rate + days remaining as MiniCard tiles
 *   3. Usage leaderboard -- top consumers by user or team (stock DataTable)
 *   4. Transaction log   -- paginated ledger detail (stock DataTable over a
 *      prop-fed query adapter; see TransactionLog)
 *   5. Active tasks      -- live running tasks (placeholder for live data)
 *
 * All data is received as props; the host (AccountPage) is responsible for
 * fetching via the BillingApi.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Card } from '../../../components/card/Card';
import { Button } from '../../../components/button/Button';
import { ToggleGroup } from '../../../components/toggle-group/ToggleGroup';
import { MiniCard, MiniContainer } from '../../../components/mini-card/MiniCard';
import { DataTable } from '../../../components/data-table/DataTable';
import type { DataTableColumn } from '../../../components/data-table/DataTable';
import { createArrayDataSource, createQueryDataSource } from '../../../components/data-table/dataSource';
import type { DataPage } from '../../../components/data-table/dataSource';
import type { CreditBalance, LedgerTransaction, TransactionsResult, UsageRollup } from '../types';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Vertical stack of the dashboard's cards (standard 16px rhythm). */
	stack: {
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	} as CSSProperties,

	/** Resource row in the balance breakdown. */
	resourceRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		padding: '6px 0',
	} as CSSProperties,

	/** Resource name label. */
	resourceLabel: {
		fontSize: 12,
		fontWeight: 500,
		color: 'var(--rr-text-primary)',
		width: 120,
		flexShrink: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap' as const,
	} as CSSProperties,

	/** Bar track (background). */
	barTrack: {
		flex: 1,
		height: 8,
		borderRadius: 4,
		background: 'var(--rr-bg-surface-alt)',
		overflow: 'hidden',
		position: 'relative' as const,
	} as CSSProperties,

	/**
	 * Bar fill (consumed portion) — shifts to warning / error color as the
	 * consumed percentage climbs.
	 *
	 * @param pct - Consumed percentage of the purchased total.
	 */
	barFill: (pct: number): CSSProperties => ({
		width: `${Math.min(pct, 100)}%`,
		height: '100%',
		borderRadius: 4,
		background: pct > 90 ? 'var(--rr-color-error)' : pct > 70 ? 'var(--rr-color-warning)' : 'var(--rr-brand)',
		transition: 'width 300ms ease',
	}),

	/** Amount label next to the bar. */
	barAmount: {
		fontSize: 11,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		width: 80,
		textAlign: 'right' as const,
		flexShrink: 0,
	} as CSSProperties,

	/** Days-remaining value when the balance runs out within a week. */
	urgentValue: {
		color: 'var(--rr-color-error)',
	} as CSSProperties,

	/** Low-capacity warning row beneath the velocity tiles. */
	urgentRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		marginTop: 12,
	} as CSSProperties,

	/** Low-capacity warning copy. */
	urgentText: {
		flex: 1,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.5,
	} as CSSProperties,

	/** Count annotation in a card header's action slot. */
	headerCount: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Green "N running" annotation in the active tasks header. */
	runningCount: {
		fontSize: 11,
		color: 'var(--rr-color-success)',
		fontWeight: 600,
	} as CSSProperties,

	/**
	 * Transaction type badge — success tint for credits, brand tint for usage.
	 *
	 * @param type - Ledger transaction type string.
	 */
	typeBadge: (type: string): CSSProperties => ({
		display: 'inline-block',
		padding: '1px 6px',
		borderRadius: 3,
		fontSize: 10,
		fontWeight: 600,
		background:
			type === 'purchase' || type === 'credit'
				? 'color-mix(in srgb, var(--rr-color-success) 15%, transparent)'
				: type === 'usage'
				? 'color-mix(in srgb, var(--rr-brand) 15%, transparent)'
				: 'var(--rr-bg-surface-alt)',
		color: type === 'purchase' || type === 'credit' ? 'var(--rr-color-success)' : type === 'usage' ? 'var(--rr-brand)' : 'var(--rr-text-secondary)',
	}),

	/** Secondary small-print table cell (descriptions, context). */
	cellMuted: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Context cell with ellipsis truncation. */
	cellContext: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		display: 'inline-block',
		maxWidth: 200,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap' as const,
		verticalAlign: 'bottom',
	} as CSSProperties,

	/** Uppercase resource cell in the transaction log. */
	cellUppercase: {
		textTransform: 'uppercase' as const,
	} as CSSProperties,

	/** Positive (credit) amount cell. */
	amountPositive: {
		color: 'var(--rr-color-success)',
	} as CSSProperties,

	/** Active task row. */
	taskRow: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '8px 0',
		borderBottom: '1px solid var(--rr-border)',
		fontSize: 12,
	} as CSSProperties,

	/** Task name. */
	taskName: {
		fontWeight: 500,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	/** Task duration line beneath the name. */
	taskDuration: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Task token count. */
	taskTokens: {
		fontWeight: 600,
		color: 'var(--rr-brand)',
	} as CSSProperties,

	/** Loading placeholder while dashboard data is fetched. */
	loading: {
		padding: '16px 0',
		fontSize: 12,
		color: 'var(--rr-text-disabled)',
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/** Formats a number to a compact display string (e.g. 1234 -> "1,234.0"). */
function fmt(n: number): string {
	return Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Formats a number with no decimals. */
function fmtInt(n: number): string {
	return Math.round(n).toLocaleString();
}

// =============================================================================
// PROPS
// =============================================================================

/** Active task entry for the live view. */
export interface ActiveTask {
	/** Task identifier. */
	taskId: string;
	/** Pipeline or source name. */
	name: string;
	/** Current cumulative token total. */
	tokensTotal: number;
	/** Task state string. */
	state: string;
	/** Duration in seconds. */
	durationSeconds: number;
}

/** Top-up plan from app_prices table. */
export interface TopupPlan {
	/** Internal price UUID. */
	id: string;
	/** Stripe price_* identifier. */
	stripePriceId: string;
	/** Display name (e.g. "3,700 tokens"). */
	nickname: string;
	/** Price in USD cents. */
	amountCents: number;
	/** Plan metadata with credits, kind, etc. */
	metadata?: Record<string, any> | null;
}

/** Props for the BillingDashboard component. */
export interface BillingDashboardProps {
	/** Net credit balance per resource. */
	balance: CreditBalance | null;
	/** Paginated transaction result. */
	transactions: TransactionsResult | null;
	/** Per-user usage rollup. */
	usageByUser: UsageRollup[];
	/** Per-team usage rollup. */
	usageByTeam: UsageRollup[];
	/** Currently running tasks with live token data. */
	activeTasks: ActiveTask[];
	/** Available top-up packs for purchase. */
	topupPlans: TopupPlan[];
	/** Whether data is still loading. */
	loading: boolean;
	/** Callback to change the transaction page. */
	onTransactionPage: (page: number) => void;
	/** Callback when user clicks a top-up pack to purchase. */
	onBuyTopup?: (plan: TopupPlan) => void;
	/** Called when the user clicks "Add more capacity" in the velocity card. */
	onAddCapacity?: () => void;
	/** Member lookup: userId -> display name. */
	memberNames?: Record<string, string>;
	/** Team lookup: teamId -> display name. */
	teamNames?: Record<string, string>;
}

// =============================================================================
// BALANCE BREAKDOWN
// =============================================================================

/** Balance breakdown with purchased vs consumed bars per resource. */
const BalanceBreakdown: React.FC<{ balance: CreditBalance | null; transactions: TransactionsResult | null }> = ({ balance, transactions }) => {
	// Compute purchased and consumed totals from transactions (if available)
	const breakdown = useMemo(() => {
		if (!transactions?.transactions?.length && !balance?.balances) return [];
		const purchased: Record<string, number> = {};
		const consumed: Record<string, number> = {};
		// Walk all transactions to build per-resource totals
		for (const tx of transactions?.transactions ?? []) {
			if (tx.amount > 0) {
				purchased[tx.resource] = (purchased[tx.resource] ?? 0) + tx.amount;
			} else {
				consumed[tx.resource] = (consumed[tx.resource] ?? 0) + Math.abs(tx.amount);
			}
		}
		// If we don't have transaction data, use balance as fallback
		const resources = new Set([...Object.keys(balance?.balances ?? {}), ...Object.keys(purchased), ...Object.keys(consumed)]);
		return Array.from(resources).map((resource) => {
			const p = purchased[resource] ?? 0;
			const c = consumed[resource] ?? 0;
			const net = balance?.balances?.[resource] ?? p - c;
			return { resource, purchased: p, consumed: c, net, pct: p > 0 ? (c / p) * 100 : 0 };
		});
	}, [balance, transactions]);

	if (!breakdown.length) return null;

	return (
		<Card header="Balance Breakdown">
			{breakdown.map(({ resource, net, pct }) => (
				<div key={resource} style={styles.resourceRow}>
					<span style={styles.resourceLabel} title={resource}>
						{resource}
					</span>
					<div style={styles.barTrack}>
						<div style={styles.barFill(pct)} />
					</div>
					<span style={styles.barAmount}>{fmt(net)}</span>
				</div>
			))}
		</Card>
	);
};

// =============================================================================
// SPENDING VELOCITY
// =============================================================================

/** Spending velocity -- burn rate, days remaining, and top-up CTA. */
const SpendingVelocity: React.FC<{
	balance: CreditBalance | null;
	transactions: TransactionsResult | null;
	onAddCapacity?: () => void;
}> = ({ balance, transactions, onAddCapacity }) => {
	const stats = useMemo(() => {
		if (!transactions?.transactions?.length) return null;

		// Calculate daily burn from usage transactions in the last 7 days
		const now = Date.now();
		const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
		let totalBurn = 0;
		let earliestUsage = now;

		for (const tx of transactions.transactions) {
			if (tx.type === 'usage' && tx.amount < 0) {
				const txTime = tx.createdAt ? new Date(tx.createdAt).getTime() : now;
				if (txTime >= weekAgo) {
					totalBurn += Math.abs(tx.amount);
					earliestUsage = Math.min(earliestUsage, txTime);
				}
			}
		}

		const daysOfData = Math.max((now - earliestUsage) / (24 * 60 * 60 * 1000), 1);
		const dailyRate = totalBurn / daysOfData;

		// Sum all positive balances
		const totalBalance = Object.values(balance?.balances ?? {}).reduce((sum, v) => sum + Math.max(v, 0), 0);

		const daysRemaining = dailyRate > 0 ? totalBalance / dailyRate : null;

		return { dailyRate, totalBurn, totalBalance, daysRemaining };
	}, [balance, transactions]);

	if (!stats) return null;

	// Urgent = within 7 days of running out
	const isUrgent = stats.daysRemaining !== null && stats.daysRemaining < 7;

	return (
		<Card header="Spending Velocity">
			{/* Metric tiles — stock MiniCards in a MiniContainer grid. */}
			<MiniContainer>
				<MiniCard value={fmt(stats.dailyRate)} label="tokens / day" />
				<MiniCard value={fmt(stats.totalBurn)} label="burned (recent)" />
				<MiniCard
					// The urgent state renders the value in the error color.
					value={stats.daysRemaining !== null ? <span style={isUrgent ? styles.urgentValue : undefined}>{fmtInt(stats.daysRemaining)}</span> : '--'}
					label="days remaining"
				/>
			</MiniContainer>
			{/* Low-capacity warning + top-up CTA — only shown when running low (<7 days) */}
			{isUrgent && (
				<div style={styles.urgentRow}>
					<div style={styles.urgentText}>
						Based on your current usage velocity, you will be running out of capacity soon. We suggest you upgrade your current plan or purchase more capacity to ensure
						uninterrupted service.
					</div>
					<Button variant="primary" small onClick={() => onAddCapacity?.()}>
						Add more capacity...
					</Button>
				</div>
			)}
		</Card>
	);
};

// =============================================================================
// USAGE LEADERBOARD
// =============================================================================

/** Flattened row shape fed to the leaderboard DataTable. */
interface LeaderRow extends Record<string, unknown> {
	/** User or team id. */
	id: string;
	/** Resolved display name. */
	name: string;
	/** Total tokens consumed across all resources. */
	total: number;
	/** Number of distinct resources consumed. */
	resources: number;
}

/** Usage leaderboard -- top consumers by user or team. */
const UsageLeaderboard: React.FC<{ usageByUser: UsageRollup[]; usageByTeam: UsageRollup[]; memberNames?: Record<string, string>; teamNames?: Record<string, string> }> = ({
	usageByUser,
	usageByTeam,
	memberNames,
	teamNames,
}) => {
	const [mode, setMode] = useState<'user' | 'team'>('user');
	const data = mode === 'user' ? usageByUser : usageByTeam;
	const names = mode === 'user' ? memberNames : teamNames;

	// Flatten rollups into table rows with resolved names and computed totals.
	const rows = useMemo<LeaderRow[]>(
		() =>
			data.map((row) => ({
				id: row.id,
				name: row.id === '__none__' ? '(unassigned)' : names?.[row.id] ?? row.id.slice(0, 8),
				total: Object.values(row.credits).reduce((s, v) => s + v, 0),
				resources: Object.keys(row.credits).length,
			})),
		[data, names]
	);

	// Client-side data source over the leaderboard rows.
	const source = useMemo(() => createArrayDataSource<LeaderRow>(rows), [rows]);

	// Column definitions — first column label follows the active mode.
	const columns = useMemo<DataTableColumn<LeaderRow>[]>(
		() => [
			{ key: 'name', label: mode === 'user' ? 'User' : 'Team', sortable: true },
			{ key: 'total', label: 'Total Tokens', align: 'right', sortable: true, render: (row) => fmt(row.total) },
			{ key: 'resources', label: 'Resources', align: 'right', sortable: true },
		],
		[mode]
	);

	if (!usageByUser.length && !usageByTeam.length) return null;

	return (
		<Card
			header="Usage Leaderboard"
			headerActions={
				<ToggleGroup<'user' | 'team'>
					options={[
						{ id: 'user', label: 'By User' },
						{ id: 'team', label: 'By Team' },
					]}
					value={mode}
					onChange={setMode}
					small
				/>
			}
			noBodyPadding
		>
			<DataTable<LeaderRow> columns={columns} source={source} emptyState={{ title: 'No usage data' }} />
		</Card>
	);
};

// =============================================================================
// TRANSACTION LOG
// =============================================================================

/**
 * Watchdog for a parked page request: if the host never feeds the requested
 * page (e.g. its fetch errored and it never updates `transactions`), the parked
 * promise is rejected after this long so the DataTable clears its loading row
 * instead of spinning forever.
 */
const PAGE_FETCH_TIMEOUT_MS = 15000;

/**
 * Paginated transaction log with user name resolution.
 *
 * The data is server-paged THROUGH PROPS: the host owns the fetch and hands
 * down one TransactionsResult page plus an `onPageChange(page)` callback. To
 * drive the stock DataTable, a query adapter bridges the prop flow: when the
 * table asks for a page already held in props it resolves synchronously; when
 * it asks for a different page the adapter calls `onPageChange` and parks the
 * promise in a ref until the matching TransactionsResult prop arrives. Sort
 * and search are declared unsupported (the host API does not accept them), so
 * the table hides those affordances.
 */
const TransactionLog: React.FC<{ transactions: TransactionsResult | null; onPageChange: (page: number) => void; memberNames?: Record<string, string> }> = ({
	transactions,
	onPageChange,
	memberNames,
}) => {
	// --- Prop bridge refs ------------------------------------------------------
	// Latest props, readable from inside the memoized source's fetcher.
	const txRef = useRef(transactions);
	txRef.current = transactions;
	const onPageRef = useRef(onPageChange);
	onPageRef.current = onPageChange;
	// The one in-flight page request the table is waiting on, if any, plus its
	// watchdog timer so a never-arriving page can't hang the table.
	const pendingRef = useRef<{
		page: number;
		resolve: (p: DataPage<LedgerTransaction>) => void;
		reject: (e: unknown) => void;
		timer: ReturnType<typeof setTimeout>;
	} | null>(null);

	// --- Query adapter -----------------------------------------------------------
	// Stable source: resolves from props when possible, otherwise asks the host
	// for the page and resolves once the prop catches up (see effect below).
	const source = useMemo(
		() =>
			createQueryDataSource<LedgerTransaction>(
				(q) => {
					// The table pages 0-based; the host API pages 1-based.
					const wanted = q.page + 1;
					const current = txRef.current;
					// Already holding the wanted page: answer synchronously from props.
					if (current && current.page === wanted) {
						return Promise.resolve({ rows: current.transactions, total: current.total });
					}
					// Ask the host to fetch; park the promise until the prop arrives, with
					// a watchdog so a failed/never-arriving fetch rejects instead of
					// spinning forever.
					return new Promise<DataPage<LedgerTransaction>>((resolve, reject) => {
						// Supersede any earlier parked request (only the newest matters).
						if (pendingRef.current) clearTimeout(pendingRef.current.timer);
						const timer = setTimeout(() => {
							// Still parked on THIS page after the timeout: give up so the
							// table clears its loading row (it keeps the previous rows).
							if (pendingRef.current && pendingRef.current.page === wanted) {
								pendingRef.current = null;
								reject(new Error(`Transaction page ${wanted} fetch timed out`));
							}
						}, PAGE_FETCH_TIMEOUT_MS);
						pendingRef.current = { page: wanted, resolve, reject, timer };
						onPageRef.current(wanted);
					});
				},
				// The host API honors pagination only — no sort or search params.
				{ sort: false, search: false, paginate: true }
			),
		[]
	);

	// --- Prop-arrival effect ------------------------------------------------------
	// When a new TransactionsResult lands, settle a parked request or handle a
	// host-initiated refresh — WITHOUT the retry loop the old `else` branch caused
	// (a clamped out-of-range page never matched, so refresh() re-requested it
	// forever).
	useEffect(() => {
		const pending = pendingRef.current;
		if (pending) {
			// A request is parked. Settle it as soon as the host delivers the wanted
			// page OR clamps to a lower one (an out-of-range page it can't serve);
			// either way stop, and let DataTable's page-clamp effect snap its index
			// back into range. Ignore a stray higher-page update (leave it parked;
			// the watchdog covers a genuinely missing page).
			if (transactions && transactions.page <= pending.page) {
				clearTimeout(pending.timer);
				pendingRef.current = null;
				pending.resolve({ rows: transactions.transactions, total: transactions.total });
			}
		} else if (transactions) {
			// No parked request: a host-initiated refresh. Nudge the table to re-run
			// its current query (it resolves synchronously from the new props).
			source.refresh();
		}
	}, [transactions, source]);

	// --- Unmount cleanup ---------------------------------------------------------
	// Clear any parked watchdog so it can't fire after the component is gone.
	useEffect(
		() => () => {
			if (pendingRef.current) clearTimeout(pendingRef.current.timer);
		},
		[]
	);

	// --- Columns -------------------------------------------------------------------
	// Cell renderings keep the existing badge / mono / muted treatments.
	const columns = useMemo<DataTableColumn<LedgerTransaction>[]>(
		() => [
			{ key: 'createdAt', label: 'Date', render: (tx) => (tx.createdAt ? new Date(tx.createdAt).toLocaleString() : '--') },
			{ key: 'userId', label: 'User', render: (tx) => (tx.userId ? memberNames?.[tx.userId] ?? tx.userId.slice(0, 8) : '--') },
			{ key: 'type', label: 'Type', render: (tx) => <span style={styles.typeBadge(tx.type)}>{tx.type}</span> },
			{ key: 'resource', label: 'Resource', render: (tx) => <span style={styles.cellUppercase}>{tx.resource}</span> },
			{ key: 'description', label: 'Description', render: (tx) => <span style={styles.cellMuted}>{tx.description || '--'}</span> },
			{
				key: 'amount',
				label: 'Amount',
				align: 'right',
				render: (tx) => (
					<span style={tx.amount >= 0 ? styles.amountPositive : undefined}>
						{tx.amount >= 0 ? '+' : ''}
						{fmt(tx.amount)}
					</span>
				),
			},
			{
				key: 'context',
				label: 'Context',
				render: (tx) => (
					<span style={styles.cellContext} title={tx.context?.source || tx.context?.task_id || ''}>
						{tx.context?.pipeline || tx.context?.source || tx.context?.pack_id || tx.context?.subscription_id || '--'}
					</span>
				),
			},
		],
		[memberNames]
	);

	if (!transactions) return null;

	return (
		<Card header="Transaction Log" headerActions={<span style={styles.headerCount}>{transactions.total} total</span>} noBodyPadding>
			<DataTable<LedgerTransaction>
				columns={columns}
				source={source}
				// The host controls the page size; offer exactly that one option so
				// the pager math matches the server's pages.
				pageSizes={[transactions.pageSize]}
				emptyState={{ title: 'No transactions yet' }}
			/>
		</Card>
	);
};

// =============================================================================
// ACTIVE TASKS
// =============================================================================

/** Active tasks with live token burn. */
const ActiveTasksView: React.FC<{ activeTasks: ActiveTask[] }> = ({ activeTasks }) => {
	if (!activeTasks.length) return null;

	return (
		<Card header="Active Tasks" headerActions={<span style={styles.runningCount}>{activeTasks.length} running</span>}>
			{activeTasks.map((task) => (
				<div key={task.taskId} style={styles.taskRow}>
					<div>
						<div style={styles.taskName}>{task.name || task.taskId}</div>
						<div style={styles.taskDuration}>
							{Math.floor(task.durationSeconds / 60)}m {Math.floor(task.durationSeconds % 60)}s
						</div>
					</div>
					<div style={styles.taskTokens}>{fmt(task.tokensTotal)} tokens</div>
				</div>
			))}
		</Card>
	);
};

// =============================================================================
// MAIN DASHBOARD
// =============================================================================

/** Billing dashboard with admin insight sections. */
export const BillingDashboard: React.FC<BillingDashboardProps> = ({
	balance,
	transactions,
	usageByUser,
	usageByTeam,
	activeTasks,
	loading,
	onTransactionPage,
	onAddCapacity,
	memberNames,
	teamNames,
}) => {
	if (loading) {
		return <div style={styles.loading}>Loading billing data...</div>;
	}

	return (
		<div style={styles.stack}>
			<BalanceBreakdown balance={balance} transactions={transactions} />
			<SpendingVelocity balance={balance} transactions={transactions} onAddCapacity={onAddCapacity} />
			<UsageLeaderboard usageByUser={usageByUser} usageByTeam={usageByTeam} memberNames={memberNames} teamNames={teamNames} />
			<ActiveTasksView activeTasks={activeTasks} />
			<TransactionLog transactions={transactions} onPageChange={onTransactionPage} memberNames={memberNames} />
		</div>
	);
};
