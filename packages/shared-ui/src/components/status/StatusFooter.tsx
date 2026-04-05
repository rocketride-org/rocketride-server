// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * StatusFooter — Current / Avg / Peak / Min statistics row.
 *
 * Ported from vscode StatusSection/StatusFooter.tsx.
 * Plain React + inline styles using --rr-* theme tokens. No MUI.
 */

import React from 'react';
import type { CSSProperties } from 'react';
import type { ChartStats } from './types';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	row: {
		display: 'flex',
		alignItems: 'center',
		gap: '12px',
		padding: '6px 0',
		flexWrap: 'wrap',
	},
	item: {
		display: 'flex',
		alignItems: 'center',
		gap: '4px',
	},
	label: {
		fontSize: 11,
		color: 'var(--rr-text-secondary, rgba(204,204,204,0.6))',
	},
	value: {
		fontSize: 11,
		fontWeight: 600,
		color: 'var(--rr-text-primary, #e0e0e0)',
	},
	separator: {
		width: 1,
		height: 12,
		backgroundColor: 'var(--rr-border, #444)',
	},
};

// =============================================================================
// TYPES
// =============================================================================

interface StatusFooterProps {
	stats: ChartStats;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * StatusFooter
 *
 * Displays summary statistics for the rate chart:
 * current rate, average, peak, and minimum.
 */
export const StatusFooter: React.FC<StatusFooterProps> = ({ stats }) => {
	return (
		<div style={styles.row}>
			<div style={styles.item}>
				<span style={styles.label}>Now:</span>
				<span style={styles.value}>{stats.current}/s</span>
			</div>
			<div style={styles.separator} />
			<div style={styles.item}>
				<span style={styles.label}>Avg:</span>
				<span style={styles.value}>{stats.average}/s</span>
			</div>
			<div style={styles.separator} />
			<div style={styles.item}>
				<span style={styles.label}>Peak:</span>
				<span style={styles.value}>{stats.peak}/s</span>
			</div>
			<div style={styles.separator} />
			<div style={styles.item}>
				<span style={styles.label}>Min:</span>
				<span style={styles.value}>{stats.minimum}/s</span>
			</div>
		</div>
	);
};

export default StatusFooter;
