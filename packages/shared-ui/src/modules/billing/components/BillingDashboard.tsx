// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * BillingDashboard -- admin billing insights rendered below the credits panel.
 *
 * Five sections. The non-tabular ones (1, 2) are classic Cards; every table
 * follows the DataGrid standard (docs/README-app-styles.html#ref-datagrid):
 * a CardDataGrid whose two-row header IS the card header, inside a headerless
 * Card shell — never a Card header stacked on a grid bar.
 *   1. Balance breakdown -- purchased vs consumed per resource with bars
 *   2. Spending velocity -- burn rate + days remaining as MiniCard tiles
 *   3. Usage leaderboard -- top consumers (CardDataGrid, LOCAL mode; the
 *      By User / By Team ToggleGroup rides the header as `actions`)
 *   4. Transaction log   -- paginated ledger detail (CardDataGrid in REMOTE
 *      mode over a prop-fed page bridge; see TransactionLog). Row click opens
 *      the transaction record panel (a contained DetailPanel) with the FULL
 *      transaction, per the record-panel standard.
 *   5. Active tasks      -- live running tasks (CardDataGrid, LOCAL mode —
 *      poll-fed rows apply silently)
 *
 * All data is received as props; the host (AccountProvider) is responsible for
 * fetching via the BillingApi.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CellComponent } from 'tabulator-tables';
import { Card, Button, MiniCard, MiniContainer, CardDataGrid, mutedEl, DetailPanel, Section, LabelValue } from 'shell';
import type { IDataGridHandle, IDataGridPage, IDataGridPageRequest, GridColumnDefinition } from 'shell';
import { ToggleGroup } from '../../../components/toggle-group/ToggleGroup';
import { formatDateValue } from 'shell/src/components/data-grid/defaults';
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
	 * Transaction type badge shape — DOM style applied by {@link typeBadgeEl};
	 * per-type tint colors are set there (success / brand / neutral).
	 */
	typeBadgeBase: {
		display: 'inline-block',
		padding: '1px 6px',
		borderRadius: '3px',
		fontSize: '10px',
		fontWeight: '600',
	} as Partial<CSSStyleDeclaration>,

	/** Uppercase resource cell in the transaction log (DOM style for the grid formatter). */
	cellUppercase: {
		textTransform: 'uppercase',
	} as Partial<CSSStyleDeclaration>,

	/** Positive (credit) amount cell (DOM style for the grid formatter). */
	amountPositive: {
		color: 'var(--rr-color-success)',
	} as Partial<CSSStyleDeclaration>,

	/** Task token count cell (DOM style for the grid formatter). */
	taskTokens: {
		fontWeight: '600',
		color: 'var(--rr-brand)',
	} as Partial<CSSStyleDeclaration>,

	/**
	 * Signed amount value in the transaction record panel — success color for
	 * credits, default text for debits (React twin of the amount cell render).
	 *
	 * @param positive - Whether the amount is a credit (>= 0).
	 */
	panelAmount: (positive: boolean): CSSProperties => ({
		color: positive ? 'var(--rr-color-success)' : 'var(--rr-text-primary)',
	}),

	/** Pretty-printed context JSON block in the transaction record panel. */
	contextPre: {
		margin: '8px 0 0',
		padding: '10px 12px',
		background: 'var(--rr-bg-surface-alt)',
		border: '1px solid var(--rr-border)',
		borderRadius: 7,
		fontFamily: "Consolas, 'Courier New', monospace",
		fontSize: 11.5,
		lineHeight: 1.5,
		color: 'var(--rr-text-primary)',
		// Wrap long values instead of forcing the panel body to scroll sideways.
		whiteSpace: 'pre-wrap' as const,
		wordBreak: 'break-word' as const,
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

/**
 * Builds the transaction-type badge element for a grid cell — success tint
 * for credits/purchases, brand tint for usage, neutral otherwise (DOM clone
 * of the old typeBadge cell render).
 *
 * @param type - Ledger transaction type string.
 * @returns The badge element.
 */
function typeBadgeEl(type: string): HTMLElement {
	const el = document.createElement('span');
	// Shape and typography from the shared base style.
	Object.assign(el.style, styles.typeBadgeBase);
	// Tint by type: credits green, usage brand, anything else neutral.
	if (type === 'purchase' || type === 'credit') {
		el.style.background = 'color-mix(in srgb, var(--rr-color-success) 15%, transparent)';
		el.style.color = 'var(--rr-color-success)';
	} else if (type === 'usage') {
		el.style.background = 'color-mix(in srgb, var(--rr-brand) 15%, transparent)';
		el.style.color = 'var(--rr-brand)';
	} else {
		el.style.background = 'var(--rr-bg-surface-alt)';
		el.style.color = 'var(--rr-text-secondary)';
	}
	el.textContent = type;
	return el;
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
	/** Callback to change the transaction page (legacy prop bridge). */
	onTransactionPage: (page: number) => void;
	/**
	 * Direct ledger query (preferred): the full list-convention request —
	 * page, size, sorters, header-filter values, search — forwards to the
	 * server. When absent, the transaction log falls back to the page-only
	 * prop bridge (search suppressed).
	 */
	fetchTransactions?: (req: IDataGridPageRequest) => Promise<TransactionsResult | null>;
	/** Org-scoped distinct ledger values for the enum checklist filters. */
	fetchTransactionDistinct?: (field: string) => Promise<(string | number | boolean)[]>;
	/** Callback when user clicks a top-up pack to purchase. */
	onBuyTopup?: (plan: TopupPlan) => void;
	/** Called when the user clicks "Add more capacity" in the velocity card. */
	onAddCapacity?: () => void;
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

/** Flattened row shape fed to the leaderboard DataGrid. */
interface LeaderRow extends Record<string, unknown> {
	/** User or team id. */
	id: string;
	/** Server-resolved display name ('--' when unresolved). */
	name: string;
	/** Total tokens consumed across all resources. */
	total: number;
	/** Number of distinct resources consumed. */
	resources: number;
}

/** Usage leaderboard -- top consumers by user or team. */
const UsageLeaderboard: React.FC<{ usageByUser: UsageRollup[]; usageByTeam: UsageRollup[] }> = ({
	usageByUser,
	usageByTeam,
}) => {
	const [mode, setMode] = useState<'user' | 'team'>('user');
	const data = mode === 'user' ? usageByUser : usageByTeam;

	// Flatten rollups into table rows with computed totals; the display name
	// arrives resolved on the rollup row itself.
	const rows = useMemo<LeaderRow[]>(
		() =>
			data.map((row) => ({
				id: row.id,
				name: row.id === '__none__' ? '(unassigned)' : row.name ?? '--',
				total: Object.values(row.credits).reduce((s, v) => s + v, 0),
				resources: Object.keys(row.credits).length,
			})),
		[data]
	);

	// Column definitions — first column label follows the active mode.
	// Declared rrTypes per the DataGrid standard: the number columns get the
	// Min/Max filter and the decimals / thousands FORMAT picks. The contract
	// indexes declare the default layout; total desc mirrors the server's
	// top-consumers-first rollup order.
	const columns = useMemo<GridColumnDefinition[]>(
		() => [
			{ title: mode === 'user' ? 'User' : 'Team', field: 'name', rrType: 'string', rrDefault: true, rrDescription: 'Consumer display name resolved server-side — user display name with email fallback, or team name; "(unassigned)" pools usage rows carrying no user/team id.', headerSort: true },
			{
				title: 'Total Tokens',
				field: 'total',
				rrType: 'number',
				rrDefault: true,
				rrDefaultSort: 'desc',
				rrDescription: 'Credits consumed by this consumer: the sum of absolute usage-ledger debits across every metered resource (not only tokens).',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				formatter: (cell: CellComponent) => fmt(cell.getValue() as number),
			},
			{ title: 'Resources', field: 'resources', rrType: 'number', rrDefault: true, rrDescription: 'Count of distinct metered resources this consumer drew from (tokens, GPU seconds, storage, ...).', hozAlign: 'right', headerHozAlign: 'right', headerSort: true, sorter: 'number' },
		],
		[mode]
	);

	if (!usageByUser.length && !usageByTeam.length) return null;

	// The grid IS the card: its two-row header carries the title and the
	// By User / By Team toggle (`actions`); the headerless Card is only the
	// bordered shell. noSearch: a short leaderboard needs no search box (the
	// tool row collapses to a plain card header); Export still covers the set.
	return (
		<Card noBodyPadding>
			<CardDataGrid<LeaderRow>
				title="Usage Leaderboard"
				actions={
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
				columns={columns}
				data={rows}
				noSearch
				emptyTitle="No usage data"
			/>
		</Card>
	);
};

// =============================================================================
// TRANSACTION LOG
// =============================================================================

/**
 * Watchdog for a parked page request: if the host never feeds the requested
 * page (e.g. its fetch errored and it never updates `transactions`), the parked
 * promise is rejected after this long so the DataGrid clears its loading
 * overlay (it keeps the previous rows) instead of spinning forever.
 */
const PAGE_FETCH_TIMEOUT_MS = 15000;

/**
 * Ledger row shape fed to the transaction DataGrid — the SDK interface plus
 * the index signature the grid's Row constraint requires.
 */
type TxRow = LedgerTransaction & Record<string, unknown>;

/**
 * Paginated transaction log.
 *
 * Two remote wirings, best first:
 *
 *  - DIRECT (`fetchTransactions` provided): the host exposes the ledger
 *    query itself, so the grid's full list-convention request — page, size,
 *    sorters, header-filter values, search term — forwards to the server
 *    verbatim and header filtering / sorting / search genuinely work.
 *
 *  - LEGACY PROP BRIDGE (no `fetchTransactions`; the VSCode host until it is
 *    wired): the host only pages via `onPageChange(page)` and hands down one
 *    TransactionsResult prop. `fetchPage` bridges the prop flow — resolving
 *    immediately when the wanted page is already in props, otherwise parking
 *    the promise until the matching prop arrives (see the prop-arrival
 *    effect). Search is suppressed in this mode (the bridge cannot honor
 *    req.search, and a no-op search box is worse than none).
 *
 * Both the grid and the host API page 1-based, so pages pass untranslated.
 *
 * Row click opens the transaction record panel (record-panel standard): a
 * contained DetailPanel showing the FULL transaction — every ledger field
 * plus the raw context JSON. The clicked row is held whole in local state
 * (REMOTE rows are transient; paging / filtering replaces them, so there is
 * no stable list to resolve the record from live).
 */
const TransactionLog: React.FC<{
	transactions: TransactionsResult | null;
	onPageChange: (page: number) => void;
	fetchTransactions?: (req: IDataGridPageRequest) => Promise<TransactionsResult | null>;
	fetchTransactionDistinct?: (field: string) => Promise<(string | number | boolean)[]>;
}> = ({ transactions, onPageChange, fetchTransactions, fetchTransactionDistinct }) => {
	// --- Prop bridge refs ------------------------------------------------------
	// Latest props, readable from inside the stable fetchPage callback.
	const txRef = useRef(transactions);
	txRef.current = transactions;
	const onPageRef = useRef(onPageChange);
	onPageRef.current = onPageChange;
	const directRef = useRef(fetchTransactions);
	directRef.current = fetchTransactions;
	// Imperative grid handle — used to re-run the query on host-initiated
	// refreshes (a new TransactionsResult with no request parked).
	const gridRef = useRef<IDataGridHandle>(null);
	// --- Record panel state ------------------------------------------------------
	// The clicked row, held WHOLE: remote pages replace the row set, so the
	// panel keeps its own copy instead of resolving live from a list.
	const [viewedTx, setViewedTx] = useState<TxRow | null>(null);
	// The one in-flight page request the grid is waiting on, if any, plus its
	// watchdog timer so a never-arriving page can't hang the grid.
	const pendingRef = useRef<{
		page: number;
		// Page size of the parked request — needed to recognise a clamped response
		// (the host answering an out-of-range request with its own last page).
		pageSize: number;
		resolve: (p: IDataGridPage<TxRow>) => void;
		reject: (e: unknown) => void;
		timer: ReturnType<typeof setTimeout>;
	} | null>(null);

	// --- REMOTE-mode fetcher -----------------------------------------------------
	// Stable bridge: DIRECT mode forwards the full request to the host's
	// ledger query; otherwise resolves from props when possible and asks the
	// host for the page, resolving once the prop catches up (effect below).
	const fetchPage = useCallback((req: IDataGridPageRequest): Promise<IDataGridPage<TxRow>> => {
		// DIRECT mode: the whole list-convention request reaches the server.
		const direct = directRef.current;
		if (direct) {
			return direct(req).then((result) => {
				if (!result) throw new Error('Transaction fetch failed');
				return { rows: result.transactions as TxRow[], total: result.total };
			});
		}
		// DataGrid pages 1-based, exactly like the host API — no translation
		// (the old 0-based stock-table adapter added 1 here).
		const wanted = req.page;
		const current = txRef.current;
		// Already holding the wanted page: answer immediately from props.
		if (current && current.page === wanted) {
			return Promise.resolve({ rows: current.transactions as TxRow[], total: current.total });
		}
		// Ask the host to fetch; park the promise until the prop arrives, with
		// a watchdog so a failed/never-arriving fetch rejects instead of
		// spinning forever.
		return new Promise<IDataGridPage<TxRow>>((resolve, reject) => {
			// Supersede any earlier parked request (only the newest matters).
			if (pendingRef.current) clearTimeout(pendingRef.current.timer);
			const timer = setTimeout(() => {
				// Still parked on THIS page after the timeout: give up so the
				// grid clears its loading overlay (it keeps the previous rows).
				if (pendingRef.current && pendingRef.current.page === wanted) {
					pendingRef.current = null;
					reject(new Error(`Transaction page ${wanted} fetch timed out`));
				}
			}, PAGE_FETCH_TIMEOUT_MS);
			pendingRef.current = { page: wanted, pageSize: req.size, resolve, reject, timer };
			onPageRef.current(wanted);
		});
	}, []);

	// --- Prop-arrival effect ------------------------------------------------------
	// When a new TransactionsResult lands, settle a parked request or handle a
	// host-initiated refresh — WITHOUT the retry loop the old `else` branch caused
	// (a clamped out-of-range page never matched, so refresh() re-requested it
	// forever).
	useEffect(() => {
		const pending = pendingRef.current;
		if (pending && transactions) {
			// A request is parked. Settle it when the host delivers EXACTLY the
			// wanted page, or when it clamps an out-of-range request to the last
			// page of the (shrunken) set — recognised from the response's own
			// total, so a stale lower page from a superseded request can NOT
			// settle a newer parked one and briefly show the wrong rows. Any
			// other page is ignored (leave it parked; the watchdog covers a
			// genuinely missing page), and Tabulator snaps its pager back into
			// range from the returned total after a clamp.
			const lastPage = Math.max(1, Math.ceil(transactions.total / pending.pageSize));
			const isClamped = pending.page > lastPage && transactions.page === lastPage;
			if (transactions.page === pending.page || isClamped) {
				clearTimeout(pending.timer);
				pendingRef.current = null;
				pending.resolve({ rows: transactions.transactions as TxRow[], total: transactions.total });
			}
		} else if (transactions) {
			// No parked request: a host-initiated refresh. Nudge the grid to re-run
			// its current page (fetchPage resolves immediately from the new props).
			gridRef.current?.refetch();
		}
	}, [transactions]);

	// --- Unmount cleanup ---------------------------------------------------------
	// Clear any parked watchdog so it can't fire after the component is gone.
	useEffect(
		() => () => {
			if (pendingRef.current) clearTimeout(pendingRef.current.timer);
		},
		[]
	);

	// --- Columns -------------------------------------------------------------------
	// Cell renderings keep the existing badge / muted / uppercase treatments,
	// with declared rrTypes per the DataGrid standard (date/number columns get
	// their typed FORMAT picks; the popup's display formatting works even
	// though this grid's filters cannot reach the prop bridge). Contract
	// indexes declare the default layout; createdAt desc is the ledger's
	// newest-first server default. The raw userId stays declared (unindexed,
	// hidden) so it remains toggleable and filterable.
	const columns = useMemo<GridColumnDefinition[]>(
		() => [
			{
				title: 'Date',
				field: 'createdAt',
				rrType: 'date',
				rrDefault: true,
				rrDefaultSort: 'desc',
				rrDescription: 'When the ledger entry was written — UTC on the wire, rendered in your local time; newest-first is the default sort.',
				headerSort: true,
				formatter: (cell: CellComponent) => {
					// formatDateValue applies the platform wire contract — a
					// zone-less ISO string IS UTC — then renders in the viewer's
					// local time. `new Date(iso).toLocaleString()` would misparse
					// the zone-less wire value as ALREADY-local and show it
					// unshifted.
					const iso = cell.getValue() as string | null;
					const text = iso ? formatDateValue(iso, { dateFormat: 'MM/DD/YY', timeFormat: 'HH:MM:SS' }) : null;
					return text ?? '--';
				},
			},
			{
				title: 'User',
				field: 'userName',
				rrType: 'string',
				rrDefault: true,
				rrDescription: 'Actor display name resolved server-side from the ledger user id, falling back to email; system-generated entries carry none.',
				headerSort: true,
				// Server-resolved display name; system events carry none.
				formatter: (cell: CellComponent) => (cell.getValue() as string | null) ?? '--',
			},
			{
				title: 'Type',
				field: 'type',
				rrType: 'enum',
				rrDefault: true,
				rrDescription: 'Ledger entry kind: purchase and credit grant credits, usage consumes them — determines the sign of Amount.',
				headerSort: true,
				formatter: (cell: CellComponent) => typeBadgeEl(cell.getValue() as string),
			},
			{
				title: 'Resource',
				field: 'resource',
				rrType: 'enum',
				rrDefault: true,
				rrDescription: 'Metered resource the credits applied to (tokens, GPU seconds, storage, ...).',
				headerSort: true,
				// Uppercase resource span (DOM clone of the old cell render).
				formatter: (cell: CellComponent) => {
					const el = document.createElement('span');
					Object.assign(el.style, styles.cellUppercase);
					el.textContent = String(cell.getValue() ?? '');
					return el;
				},
			},
			{
				title: 'Description',
				field: 'description',
				rrType: 'string',
				rrDefault: true,
				rrDescription: 'Free-text note recorded with the entry by the ledger writer (e.g. the pack purchased or the task metered).',
				headerSort: true,
				formatter: (cell: CellComponent) => mutedEl((cell.getValue() as string | null) || '--'),
			},
			{
				title: 'Amount',
				field: 'amount',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Signed credit delta: positive = credits granted (purchase, promo, refund), negative = consumption.',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				// SIGNED display: credits '+' in the success color, usage '-'.
				// The sign must show — the server sorts/filters the true signed
				// values, and an unsigned render made Min/Max bounds look wrong.
				formatter: (cell: CellComponent) => {
					const amount = cell.getValue() as number;
					const el = document.createElement('span');
					if (amount >= 0) Object.assign(el.style, styles.amountPositive);
					el.textContent = `${amount >= 0 ? '+' : '-'}${fmt(amount)}`;
					return el;
				},
			},
			{
				title: 'Context',
				field: 'context',
				rrType: 'json',
				rrDefault: true,
				rrDescription: 'Structured JSON attached to the entry (task id, pipeline, source, pack id); the cell shows one salient field — click the row for the full payload.',
				// Muted, ellipsis-truncated context with the full value as a tooltip.
				formatter: (cell: CellComponent) => {
					const tx = cell.getRow().getData() as TxRow;
					const el = mutedEl(tx.context?.pipeline || tx.context?.source || tx.context?.pack_id || tx.context?.subscription_id || '--');
					el.classList.add('rr-cell-truncate');
					el.style.maxWidth = '200px';
					el.title = tx.context?.source || tx.context?.task_id || '';
					return el;
				},
			},
			{ title: 'User ID', field: 'userId', rrType: 'string', rrDescription: 'Raw internal user UUID on the ledger row (empty for system entries); the User column shows the resolved display name.', headerSort: true },
		],
		[]
	);

	if (!transactions) return null;

	// The grid IS the card. DIRECT mode is the full standard: server-side
	// search / header filters / remote sort all reach the ledger query, and
	// the bar's own live count replaces the static total. LEGACY bridge mode
	// suppresses search (the page-only bridge cannot honor req.search — a
	// no-op search box is worse than none) and shows the prop total as
	// `actions` instead; Export walks every page through either wiring.
	return (
		<>
			<Card noBodyPadding>
				<CardDataGrid<TxRow>
					title="Transaction Log"
					actions={fetchTransactions ? undefined : <span style={styles.headerCount}>{transactions.total} total</span>}
					ref={gridRef}
					columns={columns}
					fetchPage={fetchPage}
					fetchDistinct={fetchTransactionDistinct}
					noSearch={!fetchTransactions}
					remoteSort={!!fetchTransactions}
					// LEGACY bridge: the host controls the page size; offer exactly
					// that one option so the pager math matches the server's pages.
					// DIRECT mode sizes freely with the grid defaults.
					{...(fetchTransactions ? {} : { pageSizes: [transactions.pageSize] })}
					onRowClick={(row) => setViewedTx(row)}
					emptyTitle="No transactions yet"
				/>
			</Card>

			{/* ── Record panel: the FULL transaction — an immutable event record,
			    pure inspect, so NO footer (interaction standard: footer
			    presence signals editability; header X / Escape close). ─────── */}
			{viewedTx != null && (
				<DetailPanel
					persistKey="panelDetailTransactionWidth"
					contained
					open
					onClose={() => setViewedTx(null)}
					title={`Transaction #${viewedTx.id}`}
					subtitle={viewedTx.type}
				>
					<Section label="Transaction">
						{/* formatDateValue applies the wire contract (zone-less ISO IS
						    UTC) and renders exactly like the Date column. */}
						<LabelValue label="Date">{(viewedTx.createdAt ? formatDateValue(viewedTx.createdAt, { dateFormat: 'MM/DD/YY', timeFormat: 'HH:MM:SS' }) : null) ?? '--'}</LabelValue>
						<LabelValue label="User">{viewedTx.userName ?? '--'}</LabelValue>
						<LabelValue label="Type">{viewedTx.type}</LabelValue>
						<LabelValue label="Resource">{viewedTx.resource}</LabelValue>
						<LabelValue label="Description">{viewedTx.description || '--'}</LabelValue>
						<LabelValue label="Amount">
							{/* Signed render matching the Amount column treatment. */}
							<span style={styles.panelAmount(viewedTx.amount >= 0)}>{`${viewedTx.amount >= 0 ? '+' : '-'}${fmt(viewedTx.amount)}`}</span>
						</LabelValue>
						<LabelValue label="Idempotency Key" mono>
							{viewedTx.idempotencyKey}
						</LabelValue>
					</Section>

					{/* Context: well-known fields as rows, then the raw JSON whole. */}
					{viewedTx.context != null && (
						<Section label="Context">
							{viewedTx.context.task_id != null && (
								<LabelValue label="Task" mono>
									{String(viewedTx.context.task_id)}
								</LabelValue>
							)}
							{viewedTx.context.source != null && <LabelValue label="Source">{String(viewedTx.context.source)}</LabelValue>}
							{viewedTx.context.pipeline != null && <LabelValue label="Pipeline">{String(viewedTx.context.pipeline)}</LabelValue>}
							<pre style={styles.contextPre}>{JSON.stringify(viewedTx.context, null, 2)}</pre>
						</Section>
					)}
				</DetailPanel>
			)}
		</>
	);
};

// =============================================================================
// ACTIVE TASKS
// =============================================================================

/** Row shape fed to the active-tasks CardDataGrid. */
interface TaskRow extends Record<string, unknown> {
	/** Task identifier (stable row key). */
	taskId: string;
	/** Pipeline or source name (falls back to the task id). */
	name: string;
	/** Duration in seconds (raw; the formatter renders "Xm Ys"). */
	durationSeconds: number;
	/** Current cumulative token total. */
	tokensTotal: number;
}

/**
 * Active tasks with live token burn — a LOCAL CardDataGrid: each poll hands
 * down a new `activeTasks` array, and a new data identity applies silently
 * (scroll / sort preserved), so the live counts tick without flicker.
 */
const ActiveTasksView: React.FC<{ activeTasks: ActiveTask[] }> = ({ activeTasks }) => {
	// Flatten props into grid rows (name falls back to the task id).
	const rows = useMemo<TaskRow[]>(
		() =>
			activeTasks.map((task) => ({
				taskId: task.taskId,
				name: task.name || task.taskId,
				durationSeconds: task.durationSeconds,
				tokensTotal: task.tokensTotal,
			})),
		[activeTasks]
	);

	// Declared typed columns per the DataGrid standard — the number columns
	// get Min/Max filters and the number FORMAT picks. Contract flags
	// declare the default layout; no default sort — the live poll order holds.
	const columns = useMemo<GridColumnDefinition[]>(
		() => [
			{ title: 'Task', field: 'name', rrType: 'string', rrDefault: true, rrDescription: 'Pipeline or source name of the running task; falls back to the task id when unnamed.', headerSort: true },
			{
				title: 'Duration',
				field: 'durationSeconds',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Elapsed run time of the task in seconds (rendered as minutes and seconds), refreshed by the live poll.',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				// Human duration from the raw seconds (sorting stays numeric).
				formatter: (cell: CellComponent) => {
					const secs = cell.getValue() as number;
					return `${Math.floor(secs / 60)}m ${Math.floor(secs % 60)}s`;
				},
			},
			{
				title: 'Tokens',
				field: 'tokensTotal',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Cumulative tokens the task has consumed so far; ticks upward with each poll while the task runs.',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				// Brand-colored token count (DOM clone of the old row render).
				formatter: (cell: CellComponent) => {
					const el = document.createElement('span');
					Object.assign(el.style, styles.taskTokens);
					el.textContent = `${fmt(cell.getValue() as number)} tokens`;
					return el;
				},
			},
		],
		[]
	);

	if (!activeTasks.length) return null;

	// The grid IS the card; the live "N running" count rides as `actions`.
	// noSearch + noExport: a handful of live rows needs no grid chrome — with
	// both set the grid contributes no buttons, while `actions` still renders.
	return (
		<Card noBodyPadding>
			<CardDataGrid<TaskRow>
				title="Active Tasks"
				actions={<span style={styles.runningCount}>{activeTasks.length} running</span>}
				columns={columns}
				data={rows}
				noSearch
				noExport
				emptyTitle="No active tasks"
			/>
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
	fetchTransactions,
	fetchTransactionDistinct,
	onAddCapacity,
}) => {
	if (loading) {
		return <div style={styles.loading}>Loading billing data...</div>;
	}

	return (
		<div style={styles.stack}>
			<BalanceBreakdown balance={balance} transactions={transactions} />
			<SpendingVelocity balance={balance} transactions={transactions} onAddCapacity={onAddCapacity} />
			<UsageLeaderboard usageByUser={usageByUser} usageByTeam={usageByTeam} />
			<ActiveTasksView activeTasks={activeTasks} />
			<TransactionLog transactions={transactions} onPageChange={onTransactionPage} fetchTransactions={fetchTransactions} fetchTransactionDistinct={fetchTransactionDistinct} />
		</div>
	);
};
