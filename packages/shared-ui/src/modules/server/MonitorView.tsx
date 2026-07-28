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
 * The Connections and Tasks tabs render the shared server grids. Hosts with
 * a client pass the paged `listConnections` / `listTasks` fetchers — the
 * grids then page, sort, filter, and search server-side, and the host polls
 * the combined `onRefetchReady` trigger. Hosts without fetchers (the VSCode
 * webview) get LOCAL grids over the pushed snapshot.
 *
 * Usage:
 *   import MonitorView from 'shared/modules/server';
 *   <MonitorView data={snapshot} events={activityLog} isConnected={true} />
 */

import React, { useState, useMemo, useRef, useCallback, useEffect, CSSProperties } from 'react';
import type { ListPageRequest, ListPageResponse } from 'rocketride';
import type { DashboardResponse, DashboardConnection, DashboardTask, ActivityEvent } from './types';
import { OverviewTab, ConnectionsGrid, TasksGrid, ActivityGrid } from './components';
import { TabPanelContent } from '../../components/tab-panel/TabPanelContent';
import { PageViewControl } from '../../components/page-view-control/PageViewControl';
import type { ITabPanelPanel } from '../../components/tab-panel/TabPanelContent';
import type { ViewMenu } from '../../types/viewMenu';
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
		...commonStyles.modalOverlay,
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
	// Fills the space below the top PageViewControl strip; TabPanelContent's
	// 100%-height wrapper resolves against this definite flex box.
	pageBody: {
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		minWidth: 0,
		minHeight: 0,
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
	/**
	 * Optional server-paginated connections fetcher — presence switches the
	 * Connections grid to REMOTE mode (host binds it to `listConnections`).
	 */
	listConnections?: (req: ListPageRequest) => Promise<ListPageResponse<DashboardConnection>>;
	/**
	 * Optional server-paginated tasks fetcher — presence switches the Tasks
	 * grid to REMOTE mode (host binds it to `listTasks`).
	 */
	listTasks?: (req: ListPageRequest) => Promise<ListPageResponse<DashboardTask>>;
	/**
	 * Receives ONE combined refetch that silently re-requests the current
	 * page of every remote grid — the host polls it (usePolling, 3s) the way
	 * the admin views poll their own grids.
	 */
	onRefetchReady?: (refetch: () => void) => void;
}

type TabId = 'overview' | 'connections' | 'tasks' | 'activity';

// =============================================================================
// COMPONENT
// =============================================================================

const MonitorView: React.FC<IMonitorViewProps> = ({ data, events, isConnected, onRefresh, listConnections, listTasks, onRefetchReady }) => {
	const [activeTab, setActiveTab] = useState<TabId>('overview');

	// ── Combined remote-grid refetch ─────────────────────────────────────
	// Each remote grid registers its silent current-page refetch here; the
	// host receives ONE trigger covering both (every panel stays mounted, so
	// both grids are live regardless of the active tab).
	const connectionsRefetchRef = useRef<(() => void) | null>(null);
	const tasksRefetchRef = useRef<(() => void) | null>(null);
	/** Registration callback handed to the Connections grid. */
	const handleConnectionsRefetchReady = useCallback((refetch: () => void) => {
		connectionsRefetchRef.current = refetch;
	}, []);
	/** Registration callback handed to the Tasks grid. */
	const handleTasksRefetchReady = useCallback((refetch: () => void) => {
		tasksRefetchRef.current = refetch;
	}, []);
	// Hand the host one stable combined trigger (no-op until grids mount).
	useEffect(() => {
		onRefetchReady?.(() => {
			connectionsRefetchRef.current?.();
			tasksRefetchRef.current?.();
		});
	}, [onRefetchReady]);

	// ViewMenu declaration — rendered by this view's own PageViewControl strip.
	const viewMenu = useMemo<ViewMenu>(
		() => ({
			entries: [
				{ id: 'overview', label: 'Overview' },
				{ id: 'connections', label: 'Connections', ...(data ? { count: data.overview.totalConnections } : {}) },
				{ id: 'tasks', label: 'Tasks', ...(data ? { count: data.overview.activeTasks } : {}) },
				{ id: 'activity', label: 'Activity', ...(events.length > 0 ? { count: events.length } : {}) },
			],
		}),
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
						<OverviewTab data={data} events={events} onRefresh={onRefresh} />
					</div>
				),
			},
			connections: {
				content: (
					<div style={commonStyles.tabContent}>
						{/* Snapshot rows back the LOCAL grid; a host fetcher switches
						    it REMOTE (conditional spread keeps the prop truly absent
						    for hosts without one). */}
						<ConnectionsGrid
							connections={data.connections}
							{...(listConnections ? { listConnections } : {})}
							onRefetchReady={handleConnectionsRefetchReady}
						/>
					</div>
				),
			},
			tasks: {
				content: (
					<div style={commonStyles.tabContent}>
						<TasksGrid
							tasks={data.tasks}
							{...(listTasks ? { listTasks } : {})}
							onRefetchReady={handleTasksRefetchReady}
						/>
					</div>
				),
			},
			activity: {
				content: (
					<div style={commonStyles.tabContent}>
						<ActivityGrid events={events} />
					</div>
				),
			},
		};
	}, [data, events, onRefresh, listConnections, listTasks, handleConnectionsRefetchReady, handleTasksRefetchReady]);

	return (
		<div style={styles.root}>
			{/* Page strip — the view renders its own tabs at the very top. */}
			<PageViewControl menu={viewMenu} activeId={activeTab} onSelect={(id) => setActiveTab(id as TabId)} />
			{/* Page bodies fill the space below the strip. */}
			<div style={styles.pageBody}>
				<TabPanelContent panels={panels} activeId={activeTab} />
			</div>
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
