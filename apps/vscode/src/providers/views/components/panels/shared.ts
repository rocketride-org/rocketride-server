// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Shared UI helpers for target panels (Docker, Service, etc.).
 *
 * Extracted from Deploy.tsx — split button with version dropdown,
 * status indicator, installed action buttons, styles, and types.
 */

import { CSSProperties } from 'react';

// =============================================================================
// TYPES
// These mirror the extension-host types but are duplicated here because
// the webview bundle runs in a separate JS context and cannot import
// directly from the extension host source.
// =============================================================================

/** OS-level service daemon status (polled periodically by the extension host). */
export interface ServiceStatus {
	state: 'not-installed' | 'starting' | 'running' | 'stopping' | 'stopped';
	version: string | null;
	publishedAt: string | null;
	/** Filesystem path where the service binary is installed. */
	installPath: string | null;
}

/** Docker container status (polled periodically via Docker daemon). */
export interface DockerStatus {
	/** 'no-docker' means Docker itself is not installed or the daemon is not running. */
	state: 'not-installed' | 'no-docker' | 'starting' | 'running' | 'stopping' | 'stopped';
	version: string | null;
	publishedAt: string | null;
	imageTag: string | null;
}

/** A single GitHub release entry used to populate version dropdowns. */
export interface VersionItem {
	tag_name: string;
	prerelease: boolean;
}

/** Normalized value/label pair for version dropdown options. */
export interface VersionOption {
	value: string;
	label: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Format a raw version tag for display (strips the "server-" prefix). */
export const displayVersion = (tag: string): string => {
	if (tag === 'latest') return 'Latest';
	if (tag === 'prerelease') return 'Prerelease';
	return tag.replace(/^server-/, '');
};

/** Human-readable labels with Unicode status indicators for each state. */
export const stateLabels: Record<string, string> = {
	'not-installed': '\u25CB Not installed',
	'no-docker': '\u25CB Docker unavailable',
	starting: '\u25D0 Starting...',
	running: '\u25CF Running',
	stopping: '\u25D0 Stopping...',
	stopped: '\u25CB Stopped',
};

/** Base Docker image path used to display the full image:tag in status rows. */
export const IMAGE_BASE = 'ghcr.io/rocketride-org/rocketride-engine';

// =============================================================================
// STYLES — shared across DockerPanel, ServicePanel, and future engine panels
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
		minWidth: 200,
		marginTop: 2,
		background: 'var(--vscode-dropdown-background)',
		border: '1px solid var(--vscode-dropdown-border)',
		borderRadius: 3,
		boxShadow: '0 2px 8px rgba(0, 0, 0, 0.36)',
		zIndex: 100,
		maxHeight: 160,
		overflowY: 'auto',
		padding: '1px 0',
	} as CSSProperties,
	actions: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: 8,
		marginTop: 12,
	} as CSSProperties,
	splitDropdownGroupLabel: {
		padding: '4px 8px 2px',
		fontSize: 13,
		fontWeight: 700,
		color: 'var(--vscode-foreground)',
		pointerEvents: 'none',
		userSelect: 'none',
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

/** Returns font color/weight for a given engine state (green=running, orange=transitional). */
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
// Dynamic style functions (not static objects) because hover/disabled
// states are tracked in React state rather than CSS pseudo-classes —
// webview sandboxing makes :hover unreliable in some VS Code versions.
// =============================================================================

/** Primary action button style with hover highlight and disabled dimming. */
export const primaryBtnStyle = (hovered: boolean, disabled?: boolean): CSSProperties => ({
	...panelStyles.btn,
	background: 'var(--rr-bg-button)',
	color: 'var(--rr-fg-button)',
	...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
	...(hovered && !disabled ? { filter: 'brightness(1.2)' } : {}),
});

/** Secondary (ghost) button style with hover highlight and disabled dimming. */
export const secondaryBtnStyle = (hovered: boolean, disabled?: boolean): CSSProperties => ({
	...panelStyles.btn,
	background: 'var(--vscode-button-secondaryBackground)',
	color: 'var(--vscode-button-secondaryForeground)',
	...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
	...(hovered && !disabled ? { filter: 'brightness(1.2)' } : {}),
});

/** Dropdown menu option style with selection/hover highlighting. */
export const optionStyle = (isSelected: boolean, isHovered: boolean): CSSProperties => ({
	appearance: 'none' as const,
	background: isSelected
		? 'var(--vscode-list-activeSelectionBackground)'
		: isHovered
			? 'var(--vscode-list-hoverBackground)'
			: 'none',
	border: 'none',
	width: '100%',
	textAlign: 'left',
	display: 'block',
	padding: '2px 8px 2px 20px',
	fontSize: 13,
	lineHeight: '22px',
	cursor: 'pointer',
	color: isSelected
		? 'var(--vscode-list-activeSelectionForeground)'
		: 'var(--vscode-foreground)',
});
