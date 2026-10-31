// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Tokens — Displays aggregated token consumption across all pipeline sources.
 *
 * Shows a total summary and per-source breakdown with progress bars.
 * When no data is available, shows an empty state prompt.
 *
 * Plain React + inline styles using --rr-* theme tokens. No MUI.
 */

import React from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shell';
import { EmptyState } from 'shell';

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

export interface TokenData {
	cpu_utilization?: number;
	cpu_memory?: number;
	gpu_memory?: number;
	total?: number;
}

// =============================================================================
// HELPERS
// =============================================================================

function fmt(v: number | undefined): string {
	return v !== undefined ? v.toFixed(1) : '—';
}

// =============================================================================
// COMPONENT
// =============================================================================

function TokenBar({ label, value, max }: { label: string; value: number | undefined; max: number }) {
	if (value === undefined) return null;
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

export interface SourceTokensContentProps {
	tokens: TokenData | undefined;
}

/**
 * SourceTokensContent — Renders token cards + bars for a single source.
 * Used by SourceTokensPane in ProjectView (mirrors SourceStatusPane pattern).
 */
export const SourceTokensContent: React.FC<SourceTokensContentProps> = ({ tokens }) => {
	if (!tokens) {
		return <EmptyState title="No token data" description="Token consumption appears here while the pipeline runs or when replaying a recorded run." />;
	}

	const maxTotal = tokens.total || 1;

	return (
		<>
			<div style={styles.summary}>
				<div style={styles.card}>
					<div style={styles.cardLabel}>Total Tokens</div>
					<div style={styles.cardValue}>{fmt(tokens.total)}</div>
				</div>
				<div style={styles.card}>
					<div style={styles.cardLabel}>CPU Usage</div>
					<div style={styles.cardValue}>{fmt(tokens.cpu_utilization)}</div>
				</div>
				<div style={styles.card}>
					<div style={styles.cardLabel}>CPU Memory</div>
					<div style={styles.cardValue}>{fmt(tokens.cpu_memory)}</div>
				</div>
				<div style={styles.card}>
					<div style={styles.cardLabel}>GPU Memory</div>
					<div style={styles.cardValue}>{fmt(tokens.gpu_memory)}</div>
				</div>
			</div>
			<div style={styles.bars}>
				<TokenBar label="CPU Usage" value={tokens.cpu_utilization} max={maxTotal} />
				<TokenBar label="CPU Memory" value={tokens.cpu_memory} max={maxTotal} />
				<TokenBar label="GPU Memory" value={tokens.gpu_memory} max={maxTotal} />
			</div>
		</>
	);
};
