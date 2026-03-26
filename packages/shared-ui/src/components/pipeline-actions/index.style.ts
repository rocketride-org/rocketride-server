// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Style definitions for PipelineActions and EndpointInfoModal.
 *
 * All visual properties reference --rr-* CSS custom properties defined
 * in the rocketride theme (rocketride-web.css / rocketride-vscode.css).
 */

import type { CSSProperties } from 'react';

// =============================================================================
// PipelineActions
// =============================================================================

const btnSmBase: CSSProperties = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	height: 'var(--rr-btn-sm-height, 16px)',
	padding: 'var(--rr-btn-sm-padding, 0 6px)',
	borderRadius: 'var(--rr-btn-sm-radius, 3px)',
	cursor: 'pointer',
	fontSize: 'var(--rr-btn-sm-font-size, 9px)',
	fontWeight: 500,
	lineHeight: 1,
	whiteSpace: 'nowrap',
};

export const actionsStyles: Record<string, CSSProperties> = {
	container: {
		display: 'flex',
		gap: '4px',
		marginTop: '4px',
		width: '100%',
	},

	primaryBtn: {
		...btnSmBase,
		flex: 1,
		border: 'none',
		backgroundColor: 'var(--rr-accent, #007acc)',
		color: 'var(--rr-fg-button, #fff)',
	},

	secondaryBtn: {
		...btnSmBase,
		flex: 1,
		border: '1px solid var(--rr-border, #dcdcdc)',
		backgroundColor: 'var(--rr-bg-paper, #fff)',
		color: 'var(--rr-text-secondary, #666)',
	},
};

// =============================================================================
// EndpointInfoModal
// =============================================================================

export const modalStyles: Record<string, CSSProperties> = {
	overlay: {
		position: 'fixed',
		inset: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'rgba(0, 0, 0, 0.5)',
		zIndex: 10000,
	},

	modal: {
		backgroundColor: 'var(--rr-bg-paper, #1e1e1e)',
		border: '1px solid var(--rr-border, #dcdcdc)',
		borderRadius: '8px',
		width: '100%',
		maxWidth: '500px',
		boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
	},

	header: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '14px 18px',
		borderBottom: '1px solid var(--rr-border, #dcdcdc)',
		backgroundColor: 'var(--rr-bg-widget-header, rgba(0,0,0,0.08))',
		borderRadius: '8px 8px 0 0',
	},

	title: {
		fontSize: '14px',
		fontWeight: 600,
		color: 'var(--rr-text-primary, inherit)',
	},

	closeBtn: {
		background: 'none',
		border: 'none',
		color: 'var(--rr-text-secondary, #666)',
		fontSize: '18px',
		cursor: 'pointer',
		padding: '4px 8px',
		borderRadius: '4px',
	},

	body: {
		padding: '20px',
	},

	configItem: {
		marginBottom: '16px',
	},

	configLabel: {
		fontSize: '11px',
		fontWeight: 600,
		color: 'var(--rr-text-secondary, #666)',
		textTransform: 'uppercase',
		letterSpacing: '0.5px',
		marginBottom: '6px',
	},

	configValueRow: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		backgroundColor: 'var(--rr-bg-surface-alt, var(--rr-bg-paper))',
		border: '1px solid var(--rr-border, #dcdcdc)',
		borderRadius: '4px',
		padding: '10px',
	},

	configValueLink: {
		flex: 1,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},

	link: {
		color: 'var(--rr-text-link, #007acc)',
		textDecoration: 'none',
		fontSize: '12px',
	},

	configValue: {
		flex: 1,
		fontSize: '12px',
		color: 'var(--rr-text-primary, inherit)',
		fontFamily: 'monospace',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},

	configValueMasked: {
		flex: 1,
		fontSize: '12px',
		color: 'var(--rr-text-disabled, #666)',
		fontFamily: 'monospace',
		letterSpacing: '2px',
	},

	iconBtn: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '4px 8px',
		borderRadius: '3px',
		border: '1px solid var(--rr-border, #dcdcdc)',
		cursor: 'pointer',
		backgroundColor: 'transparent',
		color: 'var(--rr-text-secondary, #666)',
		fontSize: '11px',
		fontWeight: 500,
		whiteSpace: 'nowrap',
	},

	iconBtnSuccess: {
		backgroundColor: 'var(--rr-accent, #007acc)',
		borderColor: 'var(--rr-accent, #007acc)',
		color: 'var(--rr-fg-button, #fff)',
	},

	securityNote: {
		marginTop: '16px',
		padding: '10px 12px',
		background: 'rgba(255, 152, 0, 0.1)',
		borderLeft: '3px solid var(--rr-color-warning, #e8b931)',
		borderRadius: '4px',
		fontSize: '11px',
		color: 'var(--rr-text-secondary, #666)',
		lineHeight: 1.5,
	},
};
