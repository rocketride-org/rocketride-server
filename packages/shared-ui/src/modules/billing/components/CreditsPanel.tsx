// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * CreditsPanel — pure compute credit balance widget with top-up packs.
 *
 * Shows the org's current credit balance and a grid of purchasable packs.
 * Clicking a pack calls the `onBuy` callback; the host is responsible for
 * creating the Stripe checkout session and handling the redirect/URL.
 *
 * This component is host-agnostic: it receives all data as props and
 * never fetches from the server directly.
 */

import React, { useState, useRef, type CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';
import type { CreditBalance, CreditPack } from '../types';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	/** Outer container card. */
	container: {
		padding: 20,
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 12,
	} as CSSProperties,

	/** Section heading. */
	heading: {
		fontSize: 16,
		fontWeight: 600,
		marginBottom: 8,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	/** Summary table for granted / consumed / net balance. */
	summaryTable: {
		width: '100%',
		borderCollapse: 'collapse' as const,
		marginBottom: 16,
		fontSize: 14,
	} as CSSProperties,

	summaryHeader: {
		textAlign: 'left' as const,
		fontWeight: 600,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		textTransform: 'uppercase' as const,
		letterSpacing: 0.5,
		padding: '4px 8px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	summaryCell: {
		padding: '6px 8px',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	summaryCellRight: {
		padding: '6px 8px',
		textAlign: 'right' as const,
		fontWeight: 500,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	netRow: {
		borderTop: '1px solid var(--rr-border)',
		fontWeight: 700,
	} as CSSProperties,

	/** Fallback when no balance data. */
	balanceEmpty: {
		fontSize: 14,
		fontWeight: 500,
		color: 'var(--rr-text-secondary)',
		marginBottom: 16,
	} as CSSProperties,

	/** Responsive grid of purchasable pack cards. */
	packsRow: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
		gap: 12,
		marginTop: 12,
	} as CSSProperties,

	/** Individual pack card (styled as a button for accessibility). */
	pack: {
		padding: 14,
		background: 'var(--rr-bg-default)',
		border: '1px solid var(--rr-border)',
		borderRadius: 10,
		cursor: 'pointer',
		transition: 'border-color 120ms, box-shadow 120ms',
		textAlign: 'left' as const,
		font: 'inherit',
		color: 'inherit',
		display: 'block',
		width: '100%',
	} as CSSProperties,

	/** Overlay styles when a purchase is in-flight. */
	packDisabled: {
		opacity: 0.6,
		cursor: 'wait',
	} as CSSProperties,

	/** Pack credit amount. */
	packCredits: {
		fontSize: 18,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	/** Pack price. */
	packPrice: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		marginTop: 2,
	} as CSSProperties,

	/** Pack nickname / bonus label. */
	packNickname: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		marginTop: 6,
		fontStyle: 'italic',
	} as CSSProperties,

	/** Error message banner. */
	error: {
		marginTop: 12,
		padding: 10,
		background: 'var(--rr-bg-error, #ffe5e5)',
		color: 'var(--rr-color-error, #c62828)',
		borderRadius: 8,
		fontSize: 13,
	} as CSSProperties,

	/** Empty-state placeholder text. */
	empty: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/** Formats a credit number using the browser's locale (e.g. 55000 → "55,000"). */
function formatCredits(n: number): string {
	return n.toLocaleString();
}

/**
 * Applies a label template from Stripe metadata for a given resource.
 * Replaces ``{amount}`` with the formatted number. Falls back to
 * ``"<amount> <resource>"`` when no label is configured.
 */
function applyLabel(resource: string, amount: number, labels: Record<string, string> | undefined): string {
	const template = labels?.[resource];
	if (template) return template.replace('{amount}', formatCredits(amount));
	return `${formatCredits(amount)} ${resource}`;
}

/** Converts USD cents to a locale-aware display string (e.g. 2900 → "$29.00"). */
function formatUsd(cents: number): string {
	return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
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

/** Pure credit balance widget with purchasable pack grid. */
export const CreditsPanel: React.FC<CreditsPanelProps> = ({ balance, packs, onBuy, onAddCapacity }) => {
	// ── Purchase state ──────────────────────────────────────────────────────
	const [purchasing, setPurchasing] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Synchronous guard for rapid repeated clicks. React state updates are
	// batched/async, so `purchasing` alone can miss back-to-back clicks.
	const buyInFlightRef = useRef(false);

	/** Handles a pack purchase click — delegates to the host via onBuy. */
	const handleBuy = async (pack: CreditPack) => {
		if (buyInFlightRef.current) return;
		buyInFlightRef.current = true;
		setError(null);
		setPurchasing(pack.packId);
		try {
			await onBuy(pack);
		} catch (e: any) {
			setError(e?.message ?? 'Failed to start checkout. Please try again.');
		} finally {
			setPurchasing(null);
			buyInFlightRef.current = false;
		}
	};

	// ── Render ──────────────────────────────────────────────────────────────
	return (
		<div style={S.container}>
			<div style={S.heading}>Account Balance</div>

			{/* Balance summary table — granted, consumed, net per resource */}
			{balance && balance.balances && Object.keys(balance.balances).length > 0 ? (
				<table style={S.summaryTable}>
					<thead>
						<tr>
							<th style={S.summaryHeader}>Resource</th>
							<th style={{ ...S.summaryHeader, textAlign: 'right' as const }}>Granted</th>
							<th style={{ ...S.summaryHeader, textAlign: 'right' as const }}>Consumed</th>
							<th style={{ ...S.summaryHeader, textAlign: 'right' as const }}>Balance</th>
						</tr>
					</thead>
					<tbody>
						{Object.entries(balance.balances).map(([resource, net]) => {
							const granted = balance.granted?.[resource] ?? 0;
							const consumed = balance.consumed?.[resource] ?? 0;
							const label = balance.labels?.[resource] ?? resource;
							const resourceName = label.replace('{amount}', '').trim() || resource;
							return (
								<tr key={resource}>
									<td style={{ ...S.summaryCell, textTransform: 'uppercase' }}>{resourceName}</td>
									<td style={S.summaryCellRight}>{formatCredits(granted)}</td>
									<td style={S.summaryCellRight}>{formatCredits(consumed)}</td>
									<td style={{ ...S.summaryCellRight, color: net < 0 ? 'var(--rr-color-error)' : 'var(--rr-text-primary)' }}>
										{formatCredits(Math.round(net * 10) / 10)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			) : (
				<div style={S.balanceEmpty}>— credits available</div>
			)}

			{/* Add more capacity button */}
			{onAddCapacity && (
				<div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
					<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardHeaderButton } as CSSProperties} onClick={onAddCapacity}>
						Add more capacity...
					</button>
				</div>
			)}

			{/* Error banner */}
			{error && <div style={S.error}>{error}</div>}
		</div>
	);
};
