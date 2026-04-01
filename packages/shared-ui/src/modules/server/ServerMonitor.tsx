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

import React, { useState } from 'react';
import type { DashboardResponse, DashboardEvent } from './types';
import { OverviewTab, ConnectionsTab, TasksTab, ActivityTab } from './components';

// Theme CSS — web defaults first, then VS Code overrides on top
import '../../themes/rocketride-web.css';
import '../../themes/rocketride-vscode.css';
import './styles/server-monitor.css';

// =============================================================================
// Props
// =============================================================================

export interface IServerMonitorProps {
	/** Full dashboard snapshot from rrext_dashboard response, or null if not yet loaded. */
	data: DashboardResponse | null;
	/** Activity events pushed from the server (newest first). */
	events: DashboardEvent[];
	/** Whether the client is connected to the server. */
	isConnected: boolean;
	/** Callback to request a manual data refresh from the host. */
	onRefresh?: () => void;
}

// =============================================================================
// Tabs
// =============================================================================

type TabId = 'overview' | 'connections' | 'tasks' | 'activity';

interface TabDef {
	id: TabId;
	label: string;
	badge?: (data: DashboardResponse | null, events: DashboardEvent[]) => string | undefined;
}

const TABS: TabDef[] = [
	{ id: 'overview', label: 'Overview' },
	{
		id: 'connections',
		label: 'Connections',
		badge: (data) => (data ? String(data.overview.totalConnections) : undefined),
	},
	{
		id: 'tasks',
		label: 'Tasks',
		badge: (data) => (data ? String(data.overview.activeTasks) : undefined),
	},
	{
		id: 'activity',
		label: 'Activity',
		badge: (_data, events) => (events.length > 0 ? String(events.length) : undefined),
	},
];

// =============================================================================
// Component
// =============================================================================

const ServerMonitor: React.FC<IServerMonitorProps> = ({ data, events, isConnected, onRefresh }) => {
	const [activeTab, setActiveTab] = useState<TabId>('overview');

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
		<div className="sm-root">
			<div className="sm-header">
				<div className="sm-header-title">Server Monitor</div>
				{onRefresh && (
					<button className="sm-refresh-btn" onClick={onRefresh}>
						Refresh
					</button>
				)}
			</div>

			<div className="sm-tab-bar">
				{TABS.map((tab) => {
					const badge = tab.badge?.(data, events);
					return (
						<button key={tab.id} className={`sm-tab ${activeTab === tab.id ? 'sm-tab-active' : ''}`} onClick={() => setActiveTab(tab.id)}>
							{tab.label}
							{badge && <span className="sm-tab-badge">{badge}</span>}
						</button>
					);
				})}
			</div>

			{!data ? (
				<div className="sm-disconnected">
					<div className="sm-text-muted">Loading dashboard data...</div>
				</div>
			) : (
				<>
					{activeTab === 'overview' && <OverviewTab data={data} />}
					{activeTab === 'connections' && <ConnectionsTab connections={data.connections} />}
					{activeTab === 'tasks' && <TasksTab tasks={data.tasks} />}
					{activeTab === 'activity' && <ActivityTab events={events} />}
				</>
			)}
		</div>
	);
};

export default ServerMonitor;
