// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * TabPanel — centered pill-style tab bar with content panels.
 * Panels are rendered on first activation and kept mounted thereafter,
 * with visibility toggled via display. This avoids mounting hidden panels
 * (which causes issues with components like ReactFlow that need measured
 * containers) while still preserving state once a panel has been shown.
 */

import React, { useState, useEffect, CSSProperties } from 'react';

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
		padding: '4px 16px',
		fontSize: 'var(--rr-font-size-widget)',
		fontWeight: 500,
		cursor: 'pointer',
		border: 'none',
		outline: 'none',
		backgroundColor: active ? 'var(--rr-brand)' : 'transparent',
		color: active ? 'var(--rr-fg-button)' : 'var(--rr-text-secondary)',
		transition: 'background-color 0.15s, color 0.15s',
	}),
	badge: {
		marginLeft: 4,
		fontSize: 'var(--rr-font-size-widget)',
		opacity: 0.8,
	} as CSSProperties,
	panelVisible: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,
	panelHidden: {
		display: 'none',
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
	/** Map of tab id → content. Panels mount on first activation and stay mounted. */
	panels: Record<string, React.ReactNode>;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function TabPanel({ tabs, activeTab, onTabChange, panels }: ITabPanelProps): React.ReactElement {
	// Track which panels have been activated at least once
	const [activated, setActivated] = useState<Set<string>>(() => new Set([activeTab]));

	useEffect(() => {
		setActivated((prev) => {
			if (prev.has(activeTab)) return prev;
			const next = new Set(prev);
			next.add(activeTab);
			return next;
		});
	}, [activeTab]);

	return (
		<>
			<div style={styles.bar}>
				<div style={styles.pill}>
					{tabs.map((tab) => {
						const isActive = activeTab === tab.id;
						return (
							<button key={tab.id} type="button" style={styles.segment(isActive)} onClick={() => onTabChange(tab.id)}>
								{tab.label}
								{tab.badge && <span style={styles.badge}>{tab.badge}</span>}
							</button>
						);
					})}
				</div>
			</div>
			{tabs.map((tab) => {
				if (!activated.has(tab.id)) return null;
				return (
					<div key={tab.id} style={activeTab === tab.id ? styles.panelVisible : styles.panelHidden}>
						{panels[tab.id]}
					</div>
				);
			})}
		</>
	);
}
