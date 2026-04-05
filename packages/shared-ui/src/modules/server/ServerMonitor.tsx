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

import React, { useState, useMemo } from 'react';
import type { DashboardResponse, ActivityEvent } from './types';
import { OverviewTab, ConnectionsTab, TasksTab, ActivityTab } from './components';
import { TabPanel } from '../../components/tab-panel/TabPanel';
import type { ITabPanelTab } from '../../components/tab-panel/TabPanel';

// Theme CSS — light defaults
import '../../themes/rocketride-default.css';
import './styles/server-monitor.css';

// =============================================================================
// Types
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
// Component
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

	const panels = useMemo(() => {
		if (!data) {
			const loading = (
				<div className="sm-disconnected">
					<div className="sm-text-muted">Loading dashboard data...</div>
				</div>
			);
			return { overview: loading, connections: loading, tasks: loading, activity: loading };
		}
		return {
			overview: <OverviewTab data={data} />,
			connections: <ConnectionsTab connections={data.connections} />,
			tasks: <TasksTab tasks={data.tasks} />,
			activity: <ActivityTab events={events} />,
		};
	}, [data, events]);

	// Disconnected state
	if (!isConnected) {
		return (
			<div className="sm-root">
				<div className="sm-disconnected">
					<div className="sm-disconnected-icon">&#9675;</div>
					<div>Disconnected from server</div>
					<div className="sm-text-muted">Reconnect to view server status</div>
				</div>
			</div>
		);
	}

	return (
		<div className="sm-root sm-root-tabpanel">
			<TabPanel tabs={tabs} activeTab={activeTab} onTabChange={(id) => setActiveTab(id as TabId)} panels={panels} />
		</div>
	);
};

export default ServerMonitor;
