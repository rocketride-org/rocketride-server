// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Tokens — Displays token consumption metrics for AI/ML tasks.
 *
 * Shows breakdown by resource type (CPU Usage, CPU Memory, GPU Memory) with
 * progress bars and a total count.
 *
 * Migrated from the VS Code extension's TokenSection component.
 * Plain React + inline styles using --rr-* theme tokens. No MUI.
 */

import React from 'react';
import type { CSSProperties } from 'react';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	section: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
	},
	header: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		fontSize: '13px',
		fontWeight: 600,
		color: 'var(--rr-text-primary, #ccc)',
	},
	totalDisplay: {
		fontSize: '12px',
		fontWeight: 400,
		color: 'var(--rr-text-secondary, #999)',
	},
	totalValue: {
		fontWeight: 600,
		color: 'var(--rr-brand, #007acc)',
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
		color: 'var(--rr-text-secondary, #999)',
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
	barContainer: {
		flex: 1,
		height: '6px',
		borderRadius: '3px',
		backgroundColor: 'var(--rr-bg-default, #1e1e1e)',
		overflow: 'hidden',
	},
	barFill: {
		height: '100%',
		borderRadius: '3px',
		backgroundColor: 'var(--rr-brand, #007acc)',
		transition: 'width 0.3s ease',
	},
	barValue: {
		flex: '0 0 50px',
		textAlign: 'right',
		fontSize: '12px',
		fontFamily: 'monospace',
		color: 'var(--rr-text-primary, #ccc)',
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

export interface TokensProps {
	taskStatus:
		| {
				tokens?: TokenData;
		  }
		| undefined;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const Tokens: React.FC<TokensProps> = ({ taskStatus }) => {
	if (!taskStatus?.tokens) {
		return null;
	}

	const { tokens } = taskStatus;

	const barEntries: { label: string; value: number | undefined }[] = [
		{ label: 'CPU Usage Tokens', value: tokens.cpu_utilization },
		{ label: 'CPU Memory Tokens', value: tokens.cpu_memory },
		{ label: 'GPU Memory Tokens', value: tokens.gpu_memory },
	];

	return (
		<section style={styles.section}>
			<header style={styles.header}>
				<span>Tokens</span>
				{tokens.total !== undefined && (
					<div style={styles.totalDisplay}>
						Total: <span style={styles.totalValue}>{tokens.total.toFixed(1)}</span>
					</div>
				)}
			</header>

			<div style={styles.bars}>
				{barEntries.map(
					({ label, value }) =>
						value !== undefined && (
							<div key={label} style={styles.barRow}>
								<div style={styles.barLabel}>{label}</div>
								<div style={styles.barContainer}>
									<div
										style={{
											...styles.barFill,
											width: `${Math.min((value / (tokens.total || 1)) * 100, 100)}%`,
										}}
									/>
								</div>
								<div style={styles.barValue}>{value.toFixed(1)}</div>
							</div>
						)
				)}
			</div>
		</section>
	);
};

export default Tokens;
