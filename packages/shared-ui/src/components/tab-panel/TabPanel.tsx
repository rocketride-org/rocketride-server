// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Tab bar with sliding underline indicator — same behavior as the VS Code
 * status page (`apps/vscode/.../TabPanel.tsx`), scoped with `rr-tab-*` classes
 * and themed via --rr-* tokens in `tab-panel.css`.
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';

import './tab-panel.css';

export interface ITabPanelTab {
	id: string;
	label: string;
	badge?: React.ReactNode;
}

export interface ITabPanelProps {
	tabs: ITabPanelTab[];
	activeTab: string;
	onTabChange: (id: string) => void;
	children: React.ReactNode;
	/** Class for the panel below the tab bar (default: rr-tabpanel-content). */
	contentClassName?: string;
}

export function TabPanel({ tabs, activeTab, onTabChange, children, contentClassName = 'rr-tabpanel-content' }: ITabPanelProps): React.ReactElement {
	const tabBarRef = useRef<HTMLDivElement>(null);
	const [indicator, setIndicator] = useState({ left: 0, width: 0 });

	const updateIndicator = useCallback(() => {
		const bar = tabBarRef.current;
		if (!bar) return;
		const activeButton = bar.querySelector('.rr-tab-item--active') as HTMLElement | null;
		if (activeButton) {
			// offsetLeft is in layout coords; subtract scrollLeft so the underline matches the
			// visible tab when .rr-tab-bar has overflow-x: auto.
			setIndicator({
				left: activeButton.offsetLeft - bar.scrollLeft,
				width: activeButton.offsetWidth,
			});
		}
	}, []);

	useEffect(() => {
		updateIndicator();
	}, [activeTab, updateIndicator, tabs]);

	useEffect(() => {
		const bar = tabBarRef.current;
		window.addEventListener('resize', updateIndicator);
		bar?.addEventListener('scroll', updateIndicator, { passive: true });
		return () => {
			window.removeEventListener('resize', updateIndicator);
			bar?.removeEventListener('scroll', updateIndicator);
		};
	}, [updateIndicator]);

	return (
		<>
			<div className="rr-tab-bar" ref={tabBarRef}>
				{tabs.map((tab) => (
					<button key={tab.id} type="button" className={`rr-tab-item${activeTab === tab.id ? ' rr-tab-item--active' : ''}`} onClick={() => onTabChange(tab.id)} role="tab" aria-selected={activeTab === tab.id}>
						{tab.label}
						{tab.badge && <span className="rr-tab-badge">{tab.badge}</span>}
					</button>
				))}
				<span className="rr-tab-indicator" style={{ left: indicator.left, width: indicator.width }} />
			</div>
			<div className={contentClassName} role="tabpanel">
				{children}
			</div>
		</>
	);
}
