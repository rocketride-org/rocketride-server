// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Tokens — Displays aggregated token consumption across all pipeline sources.
 *
 * Shows a total summary and per-source breakdown with progress bars.
 * Token keys are dynamic (from metrics_conversions DB) and displayed as
 * human-readable labels (e.g. gpu_compute -> "GPU Compute").
 *
 * Plain React + inline styles using --rr-* theme tokens. No MUI.
 */

import React, { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	summary: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
		gap: 12,
		marginBottom: 24,
	},
	card: {
		padding: '12px 16px',
		borderRadius: 6,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-widget)',
	},
	cardLabel: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		marginBottom: 4,
	},
	cardValue: {
		fontSize: 20,
		fontWeight: 600,
		color: 'var(--rr-brand)',
		...commonStyles.fontMono,
	},
	sourceSection: {
		marginBottom: 20,
	},
	sourceName: {
		fontSize: 'var(--rr-font-size-widget)',
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		marginBottom: 8,
	},
	bars: {
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
	},
	barRow: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
	},
	barLabel: {
		flex: '0 0 130px',
		fontSize: '12px',
		color: 'var(--rr-text-secondary)',
		...commonStyles.textEllipsis,
	},
	barContainer: {
		flex: 1,
		height: '6px',
		borderRadius: '3px',
		backgroundColor: 'var(--rr-bg-default)',
		overflow: 'hidden',
	},
	barFill: {
		height: '100%',
		borderRadius: '3px',
		backgroundColor: 'var(--rr-brand)',
		transition: 'width 0.3s ease',
	},
	barValue: {
		flex: '0 0 50px',
		textAlign: 'right',
		fontSize: '12px',
		...commonStyles.fontMono,
		color: 'var(--rr-text-primary)',
	},
};

// =============================================================================
// TYPES
// =============================================================================

/** Flat dict of metric_key -> token amount, keyed to metrics_conversions DB. */
export type TokenData = Record<string, number>;

interface TaskStatus {
	tokens?: TokenData;
	[key: string]: unknown;
}

interface SourceInfo {
	id: string;
	name: string;
}

export interface TokensProps {
	statusMap: Record<string, TaskStatus>;
	sources: SourceInfo[];
}

export interface SourceTokensContentProps {
	tokens: TokenData | undefined;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Known acronyms to uppercase in display labels. */
const ACRONYMS = new Set(['gpu', 'cpu']);

/**
 * Convert a metric key to a display label.
 *
 * Splits on underscores, capitalizes each word, and uppercases known
 * acronyms (gpu -> GPU, cpu -> CPU).
 *
 * @example formatLabel('gpu_compute')   // "GPU Compute"
 * @example formatLabel('cpu_memory')    // "CPU Memory"
 * @example formatLabel('llamaparse_pages') // "Llamaparse Pages"
 */
function formatLabel(key: string): string {
	return key
		.split('_')
		.map((word) => ACRONYMS.has(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

/**
 * Sum token dicts across multiple sources.
 *
 * Merges all keys; values for the same key are summed.
 */
function sumTokens(entries: TokenData[]): TokenData {
	const result: TokenData = {};
	for (const t of entries) {
		for (const [key, value] of Object.entries(t)) {
			result[key] = (result[key] || 0) + value;
		}
	}
	return result;
}

/** Compute total tokens from a token dict. */
function totalTokens(tokens: TokenData): number {
	let sum = 0;
	for (const v of Object.values(tokens)) sum += v;
	return sum;
}

/** Format a token value for display. */
function fmt(v: number | undefined): string {
	return v !== undefined ? v.toFixed(1) : '\u2014';
}

/** Get sorted entries from a token dict (consistent display order). */
function tokenEntries(tokens: TokenData): Array<[string, number]> {
	return Object.entries(tokens).sort(([a], [b]) => a.localeCompare(b));
}

// =============================================================================
// COMPONENT
// =============================================================================

/** Single token bar with label, progress, and value. */
function TokenBar({ label, value, max }: { label: string; value: number; max: number }) {
	const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
	return (
		<div style={styles.barRow}>
			<div style={styles.barLabel}>{label}</div>
			<div style={styles.barContainer}>
				<div style={{ ...styles.barFill, width: `${pct}%` }} />
			</div>
			<div style={styles.barValue}>{fmt(value)}</div>
		</div>
	);
}

// =============================================================================
// SINGLE-SOURCE CONTENT
// =============================================================================

/**
 * SourceTokensContent — Renders token cards + bars for a single source.
 * Used by SourceTokensPane in ProjectView (mirrors SourceStatusPane pattern).
 */
export const SourceTokensContent: React.FC<SourceTokensContentProps> = ({ tokens }) => {
	if (!tokens || Object.keys(tokens).length === 0) {
		return (
			<div style={commonStyles.empty}>
				<div style={{ marginBottom: 8, fontSize: 24, color: 'var(--rr-text-disabled)' }}>&#9677;</div>
				<div>No token data available</div>
				<div style={{ fontSize: 12, color: 'var(--rr-text-secondary)', marginTop: 4 }}>Run a pipeline to see token consumption</div>
			</div>
		);
	}

	const total = totalTokens(tokens);
	const maxTotal = total || 1;
	const entries = tokenEntries(tokens);

	return (
		<>
			<div style={styles.summary}>
				{/* Total card */}
				<div style={styles.card}>
					<div style={styles.cardLabel}>Total Tokens</div>
					<div style={styles.cardValue}>{fmt(total)}</div>
				</div>
				{/* Per-key cards */}
				{entries.map(([key, value]) => (
					<div key={key} style={styles.card}>
						<div style={styles.cardLabel}>{formatLabel(key)}</div>
						<div style={styles.cardValue}>{fmt(value)}</div>
					</div>
				))}
			</div>
			<div style={styles.bars}>
				{entries.map(([key, value]) => (
					<TokenBar key={key} label={formatLabel(key)} value={value} max={maxTotal} />
				))}
			</div>
		</>
	);
};

// =============================================================================
// MULTI-SOURCE (LEGACY)
// =============================================================================

export const Tokens: React.FC<TokensProps> = ({ statusMap, sources }) => {
	// Collect all token entries from all sources
	const { allTokens, aggregated, hasData } = useMemo(() => {
		const collected: { name: string; tokens: TokenData }[] = [];
		for (const src of sources) {
			const ts = statusMap[src.id];
			if (ts?.tokens && Object.keys(ts.tokens).length > 0) {
				collected.push({ name: src.name, tokens: ts.tokens });
			}
		}
		return {
			allTokens: collected,
			aggregated: sumTokens(collected.map((e) => e.tokens)),
			hasData: collected.length > 0,
		};
	}, [statusMap, sources]);

	if (!hasData) {
		return (
			<div style={commonStyles.empty}>
				<div style={{ marginBottom: 8, fontSize: 24, color: 'var(--rr-text-disabled)' }}>&#9677;</div>
				<div>No token data available</div>
				<div style={{ fontSize: 12, color: 'var(--rr-text-secondary)', marginTop: 4 }}>Run a pipeline to see token consumption</div>
			</div>
		);
	}

	const total = totalTokens(aggregated);
	const maxTotal = total || 1;
	const entries = tokenEntries(aggregated);

	return (
		<>
			{/* Aggregated summary cards */}
			<div style={styles.summary}>
				<div style={styles.card}>
					<div style={styles.cardLabel}>Total Tokens</div>
					<div style={styles.cardValue}>{fmt(total)}</div>
				</div>
				{entries.map(([key, value]) => (
					<div key={key} style={styles.card}>
						<div style={styles.cardLabel}>{formatLabel(key)}</div>
						<div style={styles.cardValue}>{fmt(value)}</div>
					</div>
				))}
			</div>

			{/* Per-source breakdown */}
			{allTokens.map(({ name, tokens }) => (
				<div key={name} style={styles.sourceSection}>
					{allTokens.length > 1 && <div style={styles.sourceName}>{name}</div>}
					<div style={styles.bars}>
						{tokenEntries(tokens).map(([key, value]) => (
							<TokenBar key={key} label={formatLabel(key)} value={value} max={maxTotal} />
						))}
					</div>
				</div>
			))}
		</>
	);
};

export default Tokens;
