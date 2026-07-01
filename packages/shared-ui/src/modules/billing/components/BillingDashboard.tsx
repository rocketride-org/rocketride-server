// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * BillingDashboard -- admin billing insights rendered below the credits panel.
 *
 * Five sections:
 *   1. Balance breakdown -- purchased vs consumed per resource with bars
 *   2. Spending velocity -- burn rate + days remaining projection
 *   3. Usage leaderboard -- top consumers by user or team
 *   4. Transaction log   -- paginated ledger detail
 *   5. Active tasks      -- live running tasks (placeholder for live data)
 *
 * All data is received as props; the host (AccountPage) is responsible for
 * fetching via the BillingApi.
 */

import React, { useState, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';
import type { CreditBalance, LedgerTransaction, TransactionsResult, UsageRollup } from '../types';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	/** Dashboard section card. */
	card: {
		...commonStyles.card,
		marginTop: 16,
		marginBottom: 0,
	} as CSSProperties,

	/** Card section heading. */
	heading: {
		...commonStyles.cardHeader,
	} as CSSProperties,

	/** Card body with padding. */
	body: {
		padding: '12px 18px',
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

	/** Bar fill (consumed portion). */
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

	/** Velocity stat row. */
	statRow: {
		display: 'flex',
		gap: 24,
		padding: '8px 0',
		flexWrap: 'wrap' as const,
	} as CSSProperties,

	/** Individual stat card. */
	stat: {
		flex: '1 1 140px',
		padding: 12,
		background: 'var(--rr-bg-surface-alt)',
		borderRadius: 8,
		textAlign: 'center' as const,
	} as CSSProperties,

	/** Stat value. */
	statValue: {
		fontSize: 20,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	/** Stat label. */
	statLabel: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		marginTop: 2,
	} as CSSProperties,

	/** Leaderboard table. */
	table: {
		width: '100%',
		fontSize: 12,
		borderCollapse: 'collapse' as const,
	} as CSSProperties,

	/** Table header cell. */
	th: {
		textAlign: 'left' as const,
		padding: '6px 8px',
		fontWeight: 600,
		color: 'var(--rr-text-secondary)',
		borderBottom: '1px solid var(--rr-border)',
		fontSize: 11,
		textTransform: 'uppercase' as const,
		letterSpacing: '0.3px',
	} as CSSProperties,

	/** Table body cell. */
	td: {
		padding: '6px 8px',
		color: 'var(--rr-text-primary)',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	/** Right-aligned table cell. */
	tdRight: {
		padding: '6px 8px',
		color: 'var(--rr-text-primary)',
		borderBottom: '1px solid var(--rr-border)',
		textAlign: 'right' as const,
		fontWeight: 500,
	} as CSSProperties,

	/** Toggle button group for user/team switch. */
	toggleGroup: {
		display: 'flex',
		gap: 0,
		marginBottom: 8,
	} as CSSProperties,

	/** Toggle button (active / inactive) — matches commonStyles.cardHeaderButton sizing. */
	toggle: (active: boolean): CSSProperties => ({
		...commonStyles.buttonSecondary,
		...commonStyles.cardHeaderButton,
		background: active ? 'var(--rr-brand)' : 'var(--rr-bg-paper)',
		color: active ? '#fff' : 'var(--rr-text-secondary)',
	}),

	/** Pagination row. */
	pagination: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		padding: '8px 0',
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Pagination button. */
	pageBtn: (disabled: boolean): CSSProperties => ({
		padding: '2px 8px',
		fontSize: 11,
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		background: 'var(--rr-bg-default)',
		color: disabled ? 'var(--rr-text-disabled)' : 'var(--rr-text-primary)',
		cursor: disabled ? 'default' : 'pointer',
		font: 'inherit',
		opacity: disabled ? 0.5 : 1,
	}),

	/** Empty state text. */
	empty: {
		fontSize: 12,
		color: 'var(--rr-text-disabled)',
		padding: '12px 0',
	} as CSSProperties,

	/** Transaction type badge. */
	typeBadge: (type: string): CSSProperties => ({
		display: 'inline-block',
		padding: '1px 6px',
		borderRadius: 3,
		fontSize: 10,
		fontWeight: 600,
		background: type === 'purchase' || type === 'credit' ? 'rgba(52, 211, 153, 0.15)' : type === 'usage' ? 'rgba(247, 144, 31, 0.15)' : 'var(--rr-bg-surface-alt)',
		color: type === 'purchase' || type === 'credit' ? 'var(--rr-color-success)' : type === 'usage' ? 'var(--rr-brand)' : 'var(--rr-text-secondary)',
	}),

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

	/** Task token count. */
	taskTokens: {
		fontWeight: 600,
		color: 'var(--rr-brand)',
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
		<div style={S.card}>
			<div style={S.heading}>
				<span style={commonStyles.labelUppercase}>Balance Breakdown</span>
			</div>
			<div style={S.body}>
				{breakdown.map(({ resource, purchased, consumed, net, pct }) => (
					<div key={resource} style={S.resourceRow}>
						<span style={S.resourceLabel} title={resource}>{resource}</span>
						<div style={S.barTrack}>
							<div style={S.barFill(pct)} />
						</div>
						<span style={S.barAmount}>{fmt(net)}</span>
					</div>
				))}
			</div>
		</div>
	);
};

// =============================================================================
// SPENDING VELOCITY
// =============================================================================

/** Spending velocity -- burn rate, days remaining, and top-up buttons. */
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
		<div style={S.card}>
			<div style={S.heading}>
				<span style={commonStyles.labelUppercase}>Spending Velocity</span>
			</div>
			<div style={S.body}>
				<div style={S.statRow}>
					<div style={S.stat}>
						<div style={S.statValue}>{fmt(stats.dailyRate)}</div>
						<div style={S.statLabel}>tokens / day</div>
					</div>
					<div style={S.stat}>
						<div style={S.statValue}>{fmt(stats.totalBurn)}</div>
						<div style={S.statLabel}>burned (recent)</div>
					</div>
					<div style={S.stat}>
						<div style={{ ...S.statValue, color: isUrgent ? 'var(--rr-color-error)' : 'var(--rr-text-primary)' }}>
							{stats.daysRemaining !== null ? fmtInt(stats.daysRemaining) : '--'}
						</div>
						<div style={S.statLabel}>days remaining</div>
					</div>
				</div>
				{/* Low-capacity warning + top-up CTA — only shown when running low (<7 days) */}
				{isUrgent && (
					<div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
						<div style={{ flex: 1, fontSize: 12, color: 'var(--rr-text-secondary)', lineHeight: 1.5 }}>
							Based on your current usage velocity, you will be running out of capacity soon.
							We suggest you upgrade your current plan or purchase more capacity to ensure uninterrupted service.
						</div>
						<button
							style={{ ...commonStyles.buttonPrimary, ...commonStyles.cardHeaderButton, flexShrink: 0 } as CSSProperties}
							onClick={() => onAddCapacity?.()}
						>
							Add more capacity...
						</button>
					</div>
				)}
			</div>
		</div>
	);
};

// =============================================================================
// USAGE LEADERBOARD
// =============================================================================

/** Usage leaderboard -- top consumers by user or team. */
const UsageLeaderboard: React.FC<{ usageByUser: UsageRollup[]; usageByTeam: UsageRollup[]; memberNames?: Record<string, string>; teamNames?: Record<string, string> }> = ({ usageByUser, usageByTeam, memberNames, teamNames }) => {
	const [mode, setMode] = useState<'user' | 'team'>('user');
	const data = mode === 'user' ? usageByUser : usageByTeam;
	const names = mode === 'user' ? memberNames : teamNames;

	if (!usageByUser.length && !usageByTeam.length) return null;

	return (
		<div style={S.card}>
			<div style={S.heading}>
				<span style={commonStyles.labelUppercase}>Usage Leaderboard</span>
				<div style={S.toggleGroup}>
					<button style={S.toggle(mode === 'user')} onClick={() => setMode('user')}>By User</button>
					<button style={S.toggle(mode === 'team')} onClick={() => setMode('team')}>By Team</button>
				</div>
			</div>
			<div style={S.body}>
				{data.length === 0 ? (
					<div style={S.empty}>No usage data.</div>
				) : (
					<table style={S.table}>
						<thead>
							<tr>
								<th style={S.th}>{mode === 'user' ? 'User' : 'Team'}</th>
								<th style={{ ...S.th, textAlign: 'right' }}>Total Tokens</th>
								<th style={{ ...S.th, textAlign: 'right' }}>Resources</th>
							</tr>
						</thead>
						<tbody>
							{data.slice(0, 10).map((row) => {
								const total = Object.values(row.credits).reduce((s, v) => s + v, 0);
								const displayName = row.id === '__none__' ? '(unassigned)' : names?.[row.id] ?? row.id.slice(0, 8);
								return (
									<tr key={row.id}>
										<td style={S.td}>{displayName}</td>
										<td style={S.tdRight}>{fmt(total)}</td>
										<td style={S.tdRight}>{Object.keys(row.credits).length}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
};

// =============================================================================
// TRANSACTION LOG
// =============================================================================

/** Paginated transaction log with user name resolution. */
const TransactionLog: React.FC<{ transactions: TransactionsResult | null; onPageChange: (page: number) => void; memberNames?: Record<string, string> }> = ({ transactions, onPageChange, memberNames }) => {
	if (!transactions) return null;

	const { transactions: rows, total, page, pageSize } = transactions;
	const totalPages = Math.ceil(total / pageSize) || 1;

	return (
		<div style={S.card}>
			<div style={S.heading}>
				<span style={commonStyles.labelUppercase}>Transaction Log</span>
				<span style={{ fontSize: 11, color: 'var(--rr-text-secondary)' }}>{total} total</span>
			</div>
			<div style={S.body}>
				{rows.length === 0 ? (
					<div style={S.empty}>No transactions yet.</div>
				) : (
					<>
						<table style={S.table}>
							<thead>
								<tr>
									<th style={S.th}>Date</th>
									<th style={S.th}>User</th>
									<th style={S.th}>Type</th>
									<th style={S.th}>Resource</th>
									<th style={S.th}>Description</th>
									<th style={{ ...S.th, textAlign: 'right' }}>Amount</th>
									<th style={S.th}>Context</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((tx) => (
									<tr key={tx.id}>
										<td style={S.td}>{tx.createdAt ? new Date(tx.createdAt).toLocaleString() : '--'}</td>
										<td style={S.td}>{tx.userId ? (memberNames?.[tx.userId] ?? tx.userId.slice(0, 8)) : '--'}</td>
										<td style={S.td}><span style={S.typeBadge(tx.type)}>{tx.type}</span></td>
										<td style={{ ...S.td, textTransform: 'uppercase' }}>{tx.resource}</td>
										<td style={{ ...S.td, fontSize: 11, color: 'var(--rr-text-secondary)' }}>{tx.description || '--'}</td>
										<td style={{ ...S.tdRight, color: tx.amount >= 0 ? 'var(--rr-color-success)' : 'var(--rr-text-primary)' }}>
											{tx.amount >= 0 ? '+' : ''}{fmt(tx.amount)}
										</td>
										<td style={{ ...S.td, fontSize: 11, color: 'var(--rr-text-secondary)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={tx.context?.source || tx.context?.task_id || ''}>
											{tx.context?.pipeline || tx.context?.source || tx.context?.pack_id || tx.context?.subscription_id || '--'}
										</td>
									</tr>
								))}
							</tbody>
						</table>
						<div style={S.pagination}>
							<button style={S.pageBtn(page <= 1)} disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Previous</button>
							<span>Page {page} of {totalPages}</span>
							<button style={S.pageBtn(page >= totalPages)} disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>Next</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
};

// =============================================================================
// ACTIVE TASKS
// =============================================================================

/** Active tasks with live token burn. */
const ActiveTasksView: React.FC<{ activeTasks: ActiveTask[] }> = ({ activeTasks }) => {
	if (!activeTasks.length) return null;

	return (
		<div style={S.card}>
			<div style={S.heading}>
				<span style={commonStyles.labelUppercase}>Active Tasks</span>
				<span style={{ fontSize: 11, color: 'var(--rr-color-success)', fontWeight: 600 }}>{activeTasks.length} running</span>
			</div>
			<div style={S.body}>
				{activeTasks.map((task) => (
					<div key={task.taskId} style={S.taskRow}>
						<div>
							<div style={S.taskName}>{task.name || task.taskId}</div>
							<div style={{ fontSize: 11, color: 'var(--rr-text-secondary)' }}>
								{Math.floor(task.durationSeconds / 60)}m {Math.floor(task.durationSeconds % 60)}s
							</div>
						</div>
						<div style={S.taskTokens}>{fmt(task.tokensTotal)} tokens</div>
					</div>
				))}
			</div>
		</div>
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
	topupPlans,
	loading,
	onTransactionPage,
	onBuyTopup,
	onAddCapacity,
	memberNames,
	teamNames,
}) => {
	if (loading) {
		return <div style={{ padding: '16px 0', fontSize: 12, color: 'var(--rr-text-disabled)' }}>Loading billing data...</div>;
	}

	return (
		<>
			<BalanceBreakdown balance={balance} transactions={transactions} />
			<SpendingVelocity balance={balance} transactions={transactions} onAddCapacity={onAddCapacity} />
			<UsageLeaderboard usageByUser={usageByUser} usageByTeam={usageByTeam} memberNames={memberNames} teamNames={teamNames} />
			<ActiveTasksView activeTasks={activeTasks} />
			<TransactionLog transactions={transactions} onPageChange={onTransactionPage} memberNames={memberNames} />
		</>
	);
};
