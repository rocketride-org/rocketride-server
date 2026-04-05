// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * TabPanel — centered pill-style tab bar with content panels.
 * Only the active panel is mounted; switching tabs unmounts the previous
 * panel and mounts the new one.
 */

import React, { CSSProperties } from 'react';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	bar: {
		display: 'flex',
		justifyContent: 'center',
		alignItems: 'center',
		flexShrink: 0,
		backgroundColor: 'var(--rr-bg-paper)',
		padding: '10px 0px 6px 0px',
	} as CSSProperties,
	pill: {
		display: 'flex',
		borderRadius: 6,
		border: '1px solid var(--rr-border)',
		overflow: 'hidden',
	} as CSSProperties,
	segment: (active: boolean): CSSProperties => ({
		padding: '6px 16px',
		fontSize: 'var(--rr-font-size-widget)',
		fontWeight: 500,
		cursor: 'pointer',
		border: 'none',
		outline: 'none',
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
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
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

export interface ITabPanelProps {
	tabs: ITabPanelTab[];
	activeTab: string;
	onTabChange: (id: string) => void;
	/** Map of tab id → content. Only the active panel is mounted. */
	panels: Record<string, React.ReactNode>;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function TabPanel({ tabs, activeTab, onTabChange, panels }: ITabPanelProps): React.ReactElement {
	return (
		<>
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
			<div style={styles.panel}>{panels[activeTab]}</div>
		</>
	);
}
