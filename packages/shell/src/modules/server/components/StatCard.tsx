// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React, { CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';

// =============================================================================
// STYLES
// =============================================================================

const accentColors: Record<string, string> = {
	green: 'var(--rr-color-success)',
	blue: 'var(--rr-border-focus)',
	orange: 'var(--rr-accent)',
	cyan: 'var(--rr-color-info)',
};

const colorMap: Record<string, string> = {
	success: 'var(--rr-color-success)',
	accent: 'var(--rr-border-focus)',
	info: 'var(--rr-color-info)',
	warning: 'var(--rr-color-warning)',
	error: 'var(--rr-color-error)',
	orange: 'var(--rr-accent)',
};

const styles = {
	card: (accent?: string): CSSProperties => ({
		...commonStyles.card,
		borderRadius: 10,
		padding: '20px 22px',
		position: 'relative',
		borderLeft: accent ? `3px solid ${accent}` : undefined,
	}),
	label: {
		...commonStyles.labelUppercase,
		fontSize: 10,
		letterSpacing: '1px',
		color: 'var(--rr-text-disabled)',
		marginBottom: 10,
	} as CSSProperties,
	value: (color?: string): CSSProperties => ({
		fontSize: 32,
		fontWeight: 700,
		fontVariantNumeric: 'tabular-nums',
		color: color ?? 'var(--rr-text-primary)',
		lineHeight: 1.1,
	}),
	sub: {
		fontSize: 11,
		color: 'var(--rr-text-disabled)',
		marginTop: 8,
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

interface StatCardProps {
	label: string;
	value: string | number;
	/** Color key: 'success' | 'accent' | 'info' | 'warning' | 'error' | 'orange' */
	colorClass?: string;
	/** Accent key: 'green' | 'blue' | 'orange' | 'cyan' */
	accentClass?: string;
	subtitle?: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const StatCard: React.FC<StatCardProps> = ({ label, value, colorClass, accentClass, subtitle }) => {
	const accent = accentClass ? accentColors[accentClass.replace('sm-accent-', '')] : undefined;
	const color = colorClass ? colorMap[colorClass.replace('sm-color-', '')] : undefined;

	return (
		<div style={styles.card(accent)}>
			<div style={styles.label}>{label}</div>
			<div style={styles.value(color)}>{value}</div>
			{subtitle && <div style={styles.sub}>{subtitle}</div>}
		</div>
	);
};
