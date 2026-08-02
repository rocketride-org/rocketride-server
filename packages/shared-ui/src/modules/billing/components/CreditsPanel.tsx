// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * CreditsPanel — pure compute credit balance widget.
 *
 * Shows the org's current credit balance per resource as a CardDataGrid
 * (Resource / Granted / Consumed / Balance): the grid's two-row header IS
 * the card header — "Account Balance" + the "Add more capacity..." action
 * on the identity row, the grid's search / count / Export on the tool row —
 * inside a headerless Card shell, so the card carries ONE header instead of
 * a Card header stacked on a grid bar (design decision 2026-07-16). The
 * host is responsible for the checkout flow via `onAddCapacity`.
 *
 * This component is host-agnostic: it receives all data as props and
 * never fetches from the server directly.
 */

import React, { useMemo, useState, type CSSProperties } from 'react';
import type { CellComponent } from 'tabulator-tables';
import { Card, Button, CardDataGrid } from 'shell';
import type { GridColumnDefinition } from 'shell';
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

	// Column definitions — numeric columns right-aligned like the original
	// table, with declared rrTypes so the header popups offer the matching
	// FORMAT picks (number columns: decimals / thousands / currency) and
	// filter controls instead of falling back to plain text. Contract flags
	// declare the default layout; no default sort — the balance map order holds.
	const columns = useMemo<GridColumnDefinition[]>(
		() => [
			{
				title: 'Resource',
				field: 'resource',
				rrType: 'string',
				rrDefault: true,
				rrDescription: 'Metered resource this balance row covers; the display name comes from subscription label templates, falling back to the raw resource key.',
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
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Total credits ever added for the resource — the sum of positive ledger entries (credit grants and purchases).',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				formatter: (cell: CellComponent) => formatCredits(cell.getValue() as number),
			},
			{
				title: 'Consumed',
				field: 'consumed',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Total credits used for the resource — the sum of usage debits, shown as a positive number.',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				formatter: (cell: CellComponent) => formatCredits(cell.getValue() as number),
			},
			{
				title: 'Balance',
				field: 'balance',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Net credits remaining: granted minus consumed, rounded to one decimal; negative means overspent and renders in the error color.',
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

	// Card-level action, shared by both render branches.
	const addCapacityAction = onAddCapacity ? (
		<Button variant="secondary" small onClick={onAddCapacity}>
			Add more capacity...
		</Button>
	) : undefined;

	// ── Render ──────────────────────────────────────────────────────────────
	// No data: a classic Card (header + padded body message) — there is no
	// grid to own the header yet.
	if (!hasData) {
		return (
			<Card header="Account Balance" headerActions={addCapacityAction}>
				<div style={styles.balanceEmpty}>— credits available</div>
				{/* Error banner */}
				{error && <div style={styles.error}>{error}</div>}
			</Card>
		);
	}

	// Data: the grid IS the card — a headerless Card provides only the
	// bordered shell, and the CardDataGrid's two-row header carries the
	// title, the capacity action, and the grid tools in ONE block.
	return (
		<Card noBodyPadding>
			{/* Balance table — granted, consumed, net per resource */}
			{/* noSearch: a handful of resource rows needs no search box (the
			    tool row collapses; Export stays in the right cluster). */}
			<CardDataGrid<BalanceRow> title="Account Balance" actions={addCapacityAction} columns={columns} data={rows} noSearch />

			{/* Error banner */}
			{error && <div style={styles.error}>{error}</div>}
		</Card>
	);
};
