// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * TabPanel — pill-style tab bar overlaying content panels.
 *
 * Layout:  The bar is absolutely positioned at the top center, transparent,
 *          so content (e.g. the canvas) flows underneath.
 *
 * Only the active panel is mounted; switching tabs unmounts the previous
 * panel and mounts the new one.
 */

import React, { CSSProperties } from 'react';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	wrapper: {
		position: 'relative',
		width: '100%',
		height: '100%',
	} as CSSProperties,
	bar: {
		position: 'absolute',
		top: 0,
		left: 0,
		right: 0,
		zIndex: 10,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		flexShrink: 0,
		backgroundColor: 'transparent',
		padding: '15px',
		pointerEvents: 'none',
	} as CSSProperties,
	pill: {
		display: 'flex',
		alignItems: 'stretch',
		gap: 0,
		borderRadius: 6,
		padding: 0,
		height: 38,
		pointerEvents: 'auto',
		backgroundColor: 'var(--rr-bg-widget)',
		overflow: 'hidden',
	} as CSSProperties,
	segment: (active: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		height: '100%',
		padding: '0 14px',
		fontSize: 'var(--rr-font-size-widget)',
		fontWeight: 500,
		cursor: 'pointer',
		border: 'none',
		outline: 'none',
		borderRadius: 0,
		backgroundColor: active ? 'var(--rr-brand)' : 'transparent',
		color: active ? 'var(--rr-fg-button)' : 'var(--rr-text-secondary)',
		transition: 'background-color 0.15s, color 0.15s',
	}),
	badge: (active: boolean): CSSProperties => ({
		marginLeft: 6,
		padding: '1px 6px',
		fontSize: '10px',
		fontWeight: 600,
		borderRadius: 8,
		backgroundColor: active ? 'color-mix(in srgb, var(--rr-fg-button) 30%, transparent)' : 'color-mix(in srgb, var(--rr-text-disabled) 20%, transparent)',
		color: active ? 'var(--rr-fg-button)' : 'var(--rr-text-disabled)',
	}),
	panel: {
		width: '100%',
		height: '100%',
		overflow: 'auto',
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

export interface ITabPanelTab {
	id: string;
	label: string;
	badge?: React.ReactNode;
}

export interface ITabPanelPanel {
	content: React.ReactNode;
}

export interface ITabPanelProps {
	tabs: ITabPanelTab[];
	activeTab: string;
	onTabChange: (id: string) => void;
	/** Map of tab id → { content }. Only the active panel is mounted. */
	panels: Record<string, ITabPanelPanel>;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function TabPanel({ tabs, activeTab, onTabChange, panels }: ITabPanelProps): React.ReactElement {
	return (
		<div style={styles.wrapper}>
			{Object.entries(panels).map(([id, panel]) => (
				<div key={id} style={{ ...styles.panel, display: id === activeTab ? undefined : 'none' }}>
					{panel.content}
				</div>
			))}
			<div style={styles.bar}>
				<div style={styles.pill}>
					{tabs.map((tab) => {
						const isActive = activeTab === tab.id;
						return (
							<button key={tab.id} type="button" style={styles.segment(isActive)} onClick={() => onTabChange(tab.id)}>
								{tab.label}
								{tab.badge && <span style={styles.badge(isActive)}>{tab.badge}</span>}
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}
