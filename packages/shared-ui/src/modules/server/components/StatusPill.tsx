// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React, { CSSProperties } from 'react';

// =============================================================================
// STYLES
// =============================================================================

const variantStyles: Record<string, CSSProperties> = {
	success: { background: 'rgba(34, 153, 84, 0.15)', color: 'var(--rr-color-success)' },
	warning: { background: 'rgba(232, 185, 49, 0.15)', color: 'var(--rr-color-warning)' },
	error: { background: 'rgba(250, 60, 60, 0.12)', color: 'var(--rr-color-error)' },
	info: { background: 'rgba(49, 130, 206, 0.12)', color: 'var(--rr-color-info)' },
	muted: { background: 'var(--rr-bg-widget-hover)', color: 'var(--rr-text-disabled)' },
};

const styles = {
	pill: (variant: string): CSSProperties => ({
		display: 'inline-flex',
		alignItems: 'center',
		gap: 6,
		padding: '3px 12px',
		borderRadius: 12,
		fontSize: 11,
		fontWeight: 600,
		letterSpacing: '0.3px',
		whiteSpace: 'nowrap',
		...variantStyles[variant],
	}),
};

// =============================================================================
// TYPES
// =============================================================================

interface StatusPillProps {
	label: string;
	variant: 'success' | 'warning' | 'error' | 'info' | 'muted';
}

// =============================================================================
// COMPONENT
// =============================================================================

export const StatusPill: React.FC<StatusPillProps> = ({ label, variant }) => <span style={styles.pill(variant)}>{label}</span>;
