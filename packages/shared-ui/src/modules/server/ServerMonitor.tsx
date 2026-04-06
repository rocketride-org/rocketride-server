// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * ServerMonitor — Top-level entry point for the server monitor dashboard.
 *
 * This is the single component that host applications render. It receives
 * dashboard data and events as props (data-in, callbacks-out) so that the
 * host controls all data fetching and DAP communication.
 *
 * Usage:
 *   import ServerMonitor from 'shared/modules/server';
 *   <ServerMonitor data={snapshot} events={activityLog} isConnected={true} />
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
};

// =============================================================================
// TYPES
// =============================================================================

export interface IServerMonitorProps {
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

const ServerMonitor: React.FC<IServerMonitorProps> = ({ data, events, isConnected, onRefresh }) => {
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

	const refreshBtn = onRefresh && (
		<button style={commonStyles.buttonSecondary} onClick={onRefresh}>
			Refresh
		</button>
	);

	const panels = useMemo<Record<string, ITabPanelPanel>>(() => {
		if (!data) {
			const loading = {
				content: (
					<div style={styles.disconnected}>
						<div style={commonStyles.textMuted}>Loading dashboard data...</div>
					</div>
				),
			};
			return { overview: loading, connections: loading, tasks: loading, activity: loading };
		}
		return {
			overview: { content: <OverviewTab data={data} />, actions: refreshBtn },
			connections: { content: <ConnectionsTab connections={data.connections} />, actions: refreshBtn },
			tasks: { content: <TasksTab tasks={data.tasks} />, actions: refreshBtn },
			activity: { content: <ActivityTab events={events} />, actions: refreshBtn },
		};
	}, [data, events, refreshBtn]);

	// Disconnected state
	if (!isConnected) {
		return (
			<div style={{ ...styles.root, padding: 15 }}>
				<div style={styles.disconnected}>
					<div style={styles.disconnectedIcon}>&#9675;</div>
					<div>Disconnected from server</div>
					<div style={commonStyles.textMuted}>Reconnect to view server status</div>
				</div>
			</div>
		);
	}

	return (
		<div style={styles.root}>
			<TabPanel tabs={tabs} activeTab={activeTab} onTabChange={(id) => setActiveTab(id as TabId)} panels={panels} />
		</div>
	);
};

export default ServerMonitor;
