// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * CreditsPanel — pure compute credit balance widget.
 *
 * Shows the org's current credit balance per resource as a stock DataTable
 * (Resource / Granted / Consumed / Balance) inside a stock Card headed
 * "Account Balance", with the "Add more capacity..." action in the card
 * header. The host is responsible for the checkout flow via `onAddCapacity`.
 *
 * This component is host-agnostic: it receives all data as props and
 * never fetches from the server directly.
 */

import React, { useMemo, useState, type CSSProperties } from 'react';
import { Card } from '../../../components/card/Card';
import { Button } from '../../../components/button/Button';
import { DataTable } from '../../../components/data-table/DataTable';
import type { DataTableColumn } from '../../../components/data-table/DataTable';
import { createArrayDataSource } from '../../../components/data-table/dataSource';
import type { CreditBalance, CreditPack } from '../types';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Resource name cell — uppercase like the original summary table. */
	resourceCell: {
		textTransform: 'uppercase',
	} as CSSProperties,

	/** Negative balance value — error emphasis. */
	balanceNegative: {
		color: 'var(--rr-color-error)',
	} as CSSProperties,

	/** Fallback text when no balance data has loaded. */
	balanceEmpty: {
		fontSize: 14,
		fontWeight: 500,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Error message banner. */
	error: {
		margin: 12,
		padding: 10,
		background: 'color-mix(in srgb, var(--rr-color-error) 12%, transparent)',
		color: 'var(--rr-color-error)',
		borderRadius: 8,
		fontSize: 13,
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

/** Flattened row shape fed to the balance DataTable. */
interface BalanceRow extends Record<string, unknown> {
	/** Display name of the resource (label-derived, falls back to the key). */
	resource: string;
	/** Total credits granted for the resource. */
	granted: number;
	/** Total credits consumed for the resource. */
	consumed: number;
	/** Net balance (granted minus consumed), rounded to one decimal. */
	balance: number;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Formats a credit number using the browser's locale (e.g. 55000 → "55,000"). */
function formatCredits(n: number): string {
	return n.toLocaleString();
}

// =============================================================================
// PROPS
// =============================================================================

/** Props for the pure CreditsPanel component. */
export interface CreditsPanelProps {
	/** Current credit balance for the org, or null while loading. */
	balance: CreditBalance | null;
	/** Available credit packs for purchase. */
	packs: CreditPack[];
	/** Called when the user clicks a pack to purchase. Host handles checkout. */
	onBuy: (pack: CreditPack) => Promise<void>;
	/** Called when the user clicks "Add more capacity". */
	onAddCapacity?: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

/** Pure credit balance widget — Card + DataTable over per-resource balances. */
export const CreditsPanel: React.FC<CreditsPanelProps> = ({ balance, onAddCapacity }) => {
	// ── Error state ──────────────────────────────────────────────────────────
	// The in-panel pack purchase flow was removed (the host owns checkout via
	// onAddCapacity), so nothing sets an error today; the banner remains for
	// the panel's error display slot.
	const [error] = useState<string | null>(null);

	// ── Table rows ───────────────────────────────────────────────────────────
	// Flatten the per-resource balance maps into table rows.
	const rows = useMemo<BalanceRow[]>(() => {
		if (!balance || !balance.balances) return [];
		return Object.entries(balance.balances).map(([resource, net]) => {
			// Resolve the display name from the label template, falling back to the key.
			const label = balance.labels?.[resource] ?? resource;
			const resourceName = label.replace('{amount}', '').trim() || resource;
			return {
				resource: resourceName,
				granted: balance.granted?.[resource] ?? 0,
				consumed: balance.consumed?.[resource] ?? 0,
				balance: Math.round(net * 10) / 10,
			};
		});
	}, [balance]);

	// Client-side data source over the balance rows.
	const source = useMemo(() => createArrayDataSource<BalanceRow>(rows), [rows]);

	// Column definitions — numeric columns right-aligned like the original table.
	const columns = useMemo<DataTableColumn<BalanceRow>[]>(
		() => [
			{
				key: 'resource',
				label: 'Resource',
				sortable: true,
				render: (row) => <span style={styles.resourceCell}>{row.resource}</span>,
			},
			{ key: 'granted', label: 'Granted', align: 'right', sortable: true, render: (row) => formatCredits(row.granted) },
			{ key: 'consumed', label: 'Consumed', align: 'right', sortable: true, render: (row) => formatCredits(row.consumed) },
			{
				key: 'balance',
				label: 'Balance',
				align: 'right',
				sortable: true,
				// Overspent resources render in the error color.
				render: (row) => <span style={row.balance < 0 ? styles.balanceNegative : undefined}>{formatCredits(row.balance)}</span>,
			},
		],
		[]
	);

	// Whether any per-resource balance data has loaded.
	const hasData = rows.length > 0;

	// ── Render ──────────────────────────────────────────────────────────────
	return (
		<Card
			header="Account Balance"
			headerActions={
				onAddCapacity ? (
					<Button variant="secondary" small onClick={onAddCapacity}>
						Add more capacity...
					</Button>
				) : undefined
			}
			noBodyPadding={hasData}
		>
			{/* Balance table — granted, consumed, net per resource */}
			{hasData ? <DataTable<BalanceRow> columns={columns} source={source} /> : <div style={styles.balanceEmpty}>— credits available</div>}

			{/* Error banner */}
			{error && <div style={styles.error}>{error}</div>}
		</Card>
	);
};
