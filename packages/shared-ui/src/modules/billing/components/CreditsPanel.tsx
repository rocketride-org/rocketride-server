// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * CreditsPanel — pure compute credit balance widget.
 *
 * Shows the org's current credit balance per resource as the stock DataGrid
 * (Resource / Granted / Consumed / Balance) inside a stock Card headed
 * "Account Balance", with the "Add more capacity..." action in the card
 * header. The host is responsible for the checkout flow via `onAddCapacity`.
 *
 * This component is host-agnostic: it receives all data as props and
 * never fetches from the server directly.
 */

import React, { useMemo, useState, type CSSProperties } from 'react';
import type { CellComponent, ColumnDefinition } from 'tabulator-tables';
import { Card } from '../../../components/card/Card';
import { Button } from '../../../components/button/Button';
import { DataGrid } from '../../../components/data-grid/DataGrid';
import type { CreditBalance, CreditPack } from '../types';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Resource name cell — uppercase like the original summary table (DOM style for the grid formatter). */
	resourceCell: {
		textTransform: 'uppercase',
	} as Partial<CSSStyleDeclaration>,

	/** Negative balance value — error emphasis (DOM style for the grid formatter). */
	balanceNegative: {
		color: 'var(--rr-color-error)',
	} as Partial<CSSStyleDeclaration>,

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

/** Flattened row shape fed to the balance DataGrid. */
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

/** Pure credit balance widget — Card + DataGrid over per-resource balances. */
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

	// Column definitions — numeric columns right-aligned like the original table.
	const columns = useMemo<ColumnDefinition[]>(
		() => [
			{
				title: 'Resource',
				field: 'resource',
				headerSort: true,
				// Uppercase resource-name span (DOM clone of the old cell render).
				formatter: (cell: CellComponent) => {
					const el = document.createElement('span');
					Object.assign(el.style, styles.resourceCell);
					el.textContent = String(cell.getValue() ?? '');
					return el;
				},
			},
			{
				title: 'Granted',
				field: 'granted',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				formatter: (cell: CellComponent) => formatCredits(cell.getValue() as number),
			},
			{
				title: 'Consumed',
				field: 'consumed',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				formatter: (cell: CellComponent) => formatCredits(cell.getValue() as number),
			},
			{
				title: 'Balance',
				field: 'balance',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				// Overspent resources render in the error color.
				formatter: (cell: CellComponent) => {
					const value = cell.getValue() as number;
					const el = document.createElement('span');
					if (value < 0) Object.assign(el.style, styles.balanceNegative);
					el.textContent = formatCredits(value);
					return el;
				},
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
			{hasData ? <DataGrid<BalanceRow> columns={columns} data={rows} /> : <div style={styles.balanceEmpty}>— credits available</div>}

			{/* Error banner */}
			{error && <div style={styles.error}>{error}</div>}
		</Card>
	);
};
