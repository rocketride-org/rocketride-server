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

import React, { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	empty: {
		color: 'var(--rr-text-disabled)',
		textAlign: 'center',
		padding: 32,
	},
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

// =============================================================================
// HELPERS
// =============================================================================

function sumTokens(entries: TokenData[]): TokenData {
	const result: TokenData = { cpu_utilization: 0, cpu_memory: 0, gpu_memory: 0, total: 0 };
	for (const t of entries) {
		if (t.cpu_utilization !== undefined) result.cpu_utilization! += t.cpu_utilization;
		if (t.cpu_memory !== undefined) result.cpu_memory! += t.cpu_memory;
		if (t.gpu_memory !== undefined) result.gpu_memory! += t.gpu_memory;
		if (t.total !== undefined) result.total! += t.total;
	}
	return result;
}

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
		return (
			<div style={styles.empty}>
				<div style={{ marginBottom: 8, fontSize: 24, color: 'var(--rr-text-disabled)' }}>&#9677;</div>
				<div>No token data available</div>
				<div style={{ fontSize: 12, color: 'var(--rr-text-secondary)', marginTop: 4 }}>Run a pipeline to see token consumption</div>
			</div>
		);
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

// =============================================================================
// MULTI-SOURCE (LEGACY)
// =============================================================================

export const Tokens: React.FC<TokensProps> = ({ statusMap, sources }) => {
	// Collect all token entries from all sources
	const { allTokens, aggregated, hasData } = useMemo(() => {
		const entries: { name: string; tokens: TokenData }[] = [];
		for (const src of sources) {
			const ts = statusMap[src.id];
			if (ts?.tokens) {
				entries.push({ name: src.name, tokens: ts.tokens });
			}
		}
		return {
			allTokens: entries,
			aggregated: sumTokens(entries.map((e) => e.tokens)),
			hasData: entries.length > 0,
		};
	}, [statusMap, sources]);

	if (!hasData) {
		return (
			<div style={styles.empty}>
				<div style={{ marginBottom: 8, fontSize: 24, color: 'var(--rr-text-disabled)' }}>&#9677;</div>
				<div>No token data available</div>
				<div style={{ fontSize: 12, color: 'var(--rr-text-secondary)', marginTop: 4 }}>Run a pipeline to see token consumption</div>
			</div>
		);
	}

	const maxTotal = aggregated.total || 1;

	return (
		<>
			{/* Aggregated summary cards */}
			<div style={styles.summary}>
				<div style={styles.card}>
					<div style={styles.cardLabel}>Total Tokens</div>
					<div style={styles.cardValue}>{fmt(aggregated.total)}</div>
				</div>
				<div style={styles.card}>
					<div style={styles.cardLabel}>CPU Usage</div>
					<div style={styles.cardValue}>{fmt(aggregated.cpu_utilization)}</div>
				</div>
				<div style={styles.card}>
					<div style={styles.cardLabel}>CPU Memory</div>
					<div style={styles.cardValue}>{fmt(aggregated.cpu_memory)}</div>
				</div>
				<div style={styles.card}>
					<div style={styles.cardLabel}>GPU Memory</div>
					<div style={styles.cardValue}>{fmt(aggregated.gpu_memory)}</div>
				</div>
			</div>

			{/* Per-source breakdown */}
			{allTokens.map(({ name, tokens }) => (
				<div key={name} style={styles.sourceSection}>
					{allTokens.length > 1 && <div style={styles.sourceName}>{name}</div>}
					<div style={styles.bars}>
						<TokenBar label="CPU Usage" value={tokens.cpu_utilization} max={maxTotal} />
						<TokenBar label="CPU Memory" value={tokens.cpu_memory} max={maxTotal} />
						<TokenBar label="GPU Memory" value={tokens.gpu_memory} max={maxTotal} />
					</div>
				</div>
			))}
		</>
	);
};

export default Tokens;
