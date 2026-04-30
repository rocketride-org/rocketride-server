// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * MonitorView — Top-level entry point for the server monitor dashboard.
 *
 * This is the single component that host applications render. It receives
 * dashboard data and events as props (data-in, callbacks-out) so that the
 * host controls all data fetching and DAP communication.
 *
 * Usage:
 *   import MonitorView from 'shared/modules/server';
 *   <MonitorView data={snapshot} events={activityLog} isConnected={true} />
 */

import React, { useState, useMemo, CSSProperties } from 'react';
import type { DashboardResponse, ActivityEvent } from './types';
import { OverviewTab, ConnectionsTab, TasksTab, ActivityTab } from './components';
import { TabPanel } from '../../components/tab-panel/TabPanel';
import type { ITabPanelTab, ITabPanelPanel } from '../../components/tab-panel/TabPanel';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	root: {
		position: 'relative',
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		fontFamily: 'var(--rr-font-family-widget)',
		fontSize: 'var(--rr-font-size-widget)',
		color: 'var(--rr-text-primary)',
		backgroundColor: 'var(--rr-bg-default)',
		lineHeight: 1.5,
	} as CSSProperties,
	disconnected: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		flexDirection: 'column',
		gap: 8,
		padding: '60px 24px',
		color: 'var(--rr-text-secondary)',
		textAlign: 'center',
	} as CSSProperties,
	disconnectedIcon: {
		fontSize: 32,
		color: 'var(--rr-text-disabled)',
		marginBottom: 8,
	} as CSSProperties,
	disconnectOverlay: {
		position: 'absolute',
		inset: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'rgba(0, 0, 0, 0.45)',
		backdropFilter: 'blur(8px)',
		WebkitBackdropFilter: 'blur(8px)',
		zIndex: 1000,
	} as CSSProperties,
	disconnectButton: {
		padding: '14px 40px',
		fontSize: 'var(--rr-font-size-h4)',
		fontWeight: 700,
		fontFamily: 'var(--rr-font-family)',
		color: '#ffffff',
		backgroundColor: 'transparent',
		border: '2px solid rgba(255, 255, 255, 0.7)',
		borderRadius: 6,
		cursor: 'default',
		letterSpacing: '0.05em',
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

export interface IMonitorViewProps {
	/** Full dashboard snapshot from rrext_dashboard response, or null if not yet loaded. */
	data: DashboardResponse | null;
	/** Activity events pushed from the server (newest first). */
	events: ActivityEvent[];
	/** Whether the client is connected to the server. */
	isConnected: boolean;
	/** Callback to request a manual data refresh from the host. */
	onRefresh?: () => void;
}

type TabId = 'overview' | 'connections' | 'tasks' | 'activity';

// =============================================================================
// COMPONENT
// =============================================================================

const MonitorView: React.FC<IMonitorViewProps> = ({ data, events, isConnected, onRefresh }) => {
	const [activeTab, setActiveTab] = useState<TabId>('overview');

	const tabs: ITabPanelTab[] = useMemo(
		() => [
			{ id: 'overview', label: 'Overview' },
			{ id: 'connections', label: 'Connections', badge: data ? String(data.overview.totalConnections) : undefined },
			{ id: 'tasks', label: 'Tasks', badge: data ? String(data.overview.activeTasks) : undefined },
			{ id: 'activity', label: 'Activity', badge: events.length > 0 ? String(events.length) : undefined },
		],
		[data, events.length]
	);

	const panels = useMemo<Record<string, ITabPanelPanel>>(() => {
		if (!data) {
			const loading = {
				content: (
					<div style={commonStyles.tabContent}>
						<div style={styles.disconnected}>
							<div style={commonStyles.textMuted}>Loading dashboard data...</div>
						</div>
					</div>
				),
			};
			return { overview: loading, connections: loading, tasks: loading, activity: loading };
		}
		return {
			overview: {
				content: (
					<div style={commonStyles.tabContent}>
						<OverviewTab data={data} />
					</div>
				),
			},
			connections: {
				content: (
					<div style={commonStyles.tabContent}>
						<ConnectionsTab connections={data.connections} />
					</div>
				),
			},
			tasks: {
				content: (
					<div style={commonStyles.tabContent}>
						<TasksTab tasks={data.tasks} />
					</div>
				),
			},
			activity: {
				content: (
					<div style={commonStyles.tabContent}>
						<ActivityTab events={events} />
					</div>
				),
			},
		};
	}, [data, events]);

	return (
		<div style={styles.root}>
			<TabPanel tabs={tabs} activeTab={activeTab} onTabChange={(id) => setActiveTab(id as TabId)} panels={panels} />
			{!isConnected && (
				<div style={styles.disconnectOverlay}>
					<button type="button" style={styles.disconnectButton} disabled>
						[ Disconnected ]
					</button>
				</div>
			)}
		</div>
	);
};

export default MonitorView;
