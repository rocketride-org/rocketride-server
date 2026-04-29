// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Shared UI helpers for target panels (Docker, Service, etc.).
 *
 * Extracted from PageDeploy.tsx — split button with version dropdown,
 * status indicator, installed action buttons, styles, and types.
 */

import { CSSProperties } from 'react';

// =============================================================================
// TYPES (duplicated from extension host — webview cannot import from there)
// =============================================================================

export interface ServiceStatus {
	state: 'not-installed' | 'starting' | 'running' | 'stopping' | 'stopped';
	version: string | null;
	publishedAt: string | null;
	installPath: string | null;
}

export interface DockerStatus {
	state: 'not-installed' | 'no-docker' | 'starting' | 'running' | 'stopping' | 'stopped';
	version: string | null;
	publishedAt: string | null;
	imageTag: string | null;
}

export interface VersionItem {
	tag_name: string;
	prerelease: boolean;
}

export interface VersionOption {
	value: string;
	label: string;
}

// =============================================================================
// HELPERS
// =============================================================================

export const displayVersion = (tag: string): string => {
	if (tag === 'latest') return 'Latest';
	if (tag === 'prerelease') return 'Prerelease';
	return tag.replace(/^server-/, '');
};

export const stateLabels: Record<string, string> = {
	'not-installed': '\u25CB Not installed',
	'no-docker': '\u25CB Docker unavailable',
	starting: '\u25D0 Starting...',
	running: '\u25CF Running',
	stopping: '\u25D0 Stopping...',
	stopped: '\u25CB Stopped',
};

export const IMAGE_BASE = 'ghcr.io/rocketride-org/rocketride-engine';

// =============================================================================
// STYLES
// =============================================================================

export const panelStyles = {
	statusBlock: {
		display: 'flex',
		flexDirection: 'column',
		gap: 4,
		marginTop: 8,
		fontSize: 13,
	} as CSSProperties,
	statusRow: {
		display: 'flex',
		gap: 8,
		alignItems: 'baseline',
	} as CSSProperties,
	btn: {
		padding: '8px 14px',
		fontSize: 13,
		border: 'none',
		borderRadius: 4,
		cursor: 'pointer',
	} as CSSProperties,
	splitButton: {
		position: 'relative',
		display: 'inline-flex',
	} as CSSProperties,
	splitDropdown: {
		position: 'absolute',
		top: '100%',
		left: 0,
		right: 0,
		minWidth: 180,
		marginTop: 2,
		background: 'var(--rr-bg-input)',
		border: '1px solid var(--rr-border-input)',
		borderRadius: 4,
		boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
		zIndex: 100,
		maxHeight: 200,
		overflowY: 'auto',
	} as CSSProperties,
	actions: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: 8,
		marginTop: 12,
	} as CSSProperties,
	progress: {
		fontSize: 11,
		fontFamily: 'var(--vscode-editor-font-family)',
		color: 'var(--rr-text-secondary)',
		marginTop: 4,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		maxWidth: '100%',
	} as CSSProperties,
	error: {
		fontSize: 12,
		color: 'var(--rr-color-error)',
		marginTop: 4,
	} as CSSProperties,
};

// =============================================================================
// STATUS INDICATOR STYLE
// =============================================================================

export const statusIndicatorStyle = (state: string): CSSProperties => {
	if (state === 'running') {
		return { color: '#4caf50', fontWeight: 600 };
	}
	if (state === 'starting' || state === 'stopping') {
		return { color: '#ff9800', fontWeight: 600 };
	}
	if (state === 'stopped') {
		return { color: 'var(--rr-text-secondary)' };
	}
	// not-installed, no-docker
	return { color: 'var(--rr-text-secondary)', fontStyle: 'italic' };
};

// =============================================================================
// BUTTON STYLE HELPERS
// =============================================================================

export const primaryBtnStyle = (hovered: boolean, disabled?: boolean): CSSProperties => ({
	...panelStyles.btn,
	background: 'var(--rr-bg-button)',
	color: 'var(--rr-fg-button)',
	...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
	...(hovered && !disabled ? { filter: 'brightness(1.2)' } : {}),
});

export const secondaryBtnStyle = (hovered: boolean, disabled?: boolean): CSSProperties => ({
	...panelStyles.btn,
	background: 'var(--vscode-button-secondaryBackground)',
	color: 'var(--vscode-button-secondaryForeground)',
	...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
	...(hovered && !disabled ? { filter: 'brightness(1.2)' } : {}),
});

export const optionStyle = (isSelected: boolean, isHovered: boolean): CSSProperties => ({
	appearance: 'none' as const,
	background: isSelected ? 'var(--rr-bg-list-active)' : isHovered ? 'var(--rr-bg-list-hover)' : 'none',
	border: 'none',
	width: '100%',
	textAlign: 'left',
	display: 'block',
	padding: '6px 12px',
	fontSize: 13,
	cursor: 'pointer',
	color: isSelected ? 'var(--rr-fg-list-active)' : 'var(--rr-text-primary)',
});
