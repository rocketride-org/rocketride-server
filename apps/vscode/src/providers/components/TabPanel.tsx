import React, { useRef, useState, useEffect, useCallback } from 'react';

interface Tab {
	id: string;
	label: string;
	badge?: React.ReactNode;
}

interface TabPanelProps {
	tabs: Tab[];
	activeTab: string;
	onTabChange: (id: string) => void;
	children: React.ReactNode;
}

export const TabPanel: React.FC<TabPanelProps> = ({ tabs, activeTab, onTabChange, children }) => {
	const tabBarRef = useRef<HTMLDivElement>(null);
	const [indicator, setIndicator] = useState({ left: 0, width: 0 });

	const updateIndicator = useCallback(() => {
		const bar = tabBarRef.current;
		if (!bar) return;
		const activeButton = bar.querySelector('.tab-item.active') as HTMLElement | null;
		if (activeButton) {
			setIndicator({
				left: activeButton.offsetLeft - bar.scrollLeft,
				width: activeButton.offsetWidth,
			});
		}
	}, []);

	useEffect(() => {
		updateIndicator();
	}, [activeTab, updateIndicator]);

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
			<div className="tab-bar" ref={tabBarRef}>
				{tabs.map((tab) => (
					<button key={tab.id} className={`tab-item${activeTab === tab.id ? ' active' : ''}`} onClick={() => onTabChange(tab.id)} role="tab" aria-selected={activeTab === tab.id}>
						{tab.label}
						{tab.badge && <span className="tab-badge">{tab.badge}</span>}
					</button>
				))}
				<span className="tab-indicator" style={{ left: indicator.left, width: indicator.width }} />
			</div>
			<div className="tab-content" role="tabpanel">
				{children}
			</div>
		</>
	);
};
