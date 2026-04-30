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
import type { CreditBalance, CreditPack } from '../types';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	/** Outer container card. */
	container: {
		marginTop: 24,
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

	/** Balance number + unit row. */
	balanceRow: {
		display: 'flex',
		alignItems: 'baseline',
		gap: 10,
		marginBottom: 16,
	} as CSSProperties,

	/** Large balance number. */
	balance: {
		fontSize: 28,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	/** "credits available" unit label. */
	balanceUnit: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
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

/** Formats a large credit number into a compact string (e.g. 55000 → "55.0k"). */
function formatCredits(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return n.toLocaleString();
}

/** Converts USD cents to a display string (e.g. 2900 → "$29", 1599 → "$15.99"). */
function formatUsd(cents: number): string {
	return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
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
}

// =============================================================================
// COMPONENT
// =============================================================================

/** Pure credit balance widget with purchasable pack grid. */
export const CreditsPanel: React.FC<CreditsPanelProps> = ({ balance, packs, onBuy }) => {
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
			<div style={S.heading}>Compute credits</div>

			{/* Balance display */}
			<div style={S.balanceRow}>
				<span style={S.balance}>{balance ? formatCredits(balance.balance) : '—'}</span>
				<span style={S.balanceUnit}>credits available</span>
			</div>

			{/* Pack grid or empty state */}
			{packs.length === 0 ? (
				<p style={S.empty}>No credit packs configured.</p>
			) : (
				<div style={S.packsRow}>
					{packs.map((pack) => {
						// Disable all packs while any purchase is in-flight
						const disabled = purchasing !== null;
						const style = { ...S.pack, ...(disabled ? S.packDisabled : {}) };
						return (
							<button type="button" key={pack.packId} style={style} disabled={disabled} onClick={() => handleBuy(pack)}>
								<div style={S.packCredits}>{formatCredits(pack.credits)} credits</div>
								<div style={S.packPrice}>{formatUsd(pack.usdCents)}</div>
								<div style={S.packNickname}>{pack.nickname}</div>
							</button>
						);
					})}
				</div>
			)}

			{/* Error banner */}
			{error && <div style={S.error}>{error}</div>}
		</div>
	);
};
