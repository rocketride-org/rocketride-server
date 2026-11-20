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
 *   import { MonitorView } from 'shell';
 *   <MonitorView data={snapshot} events={activityLog} />
 */

import React, { useState, useMemo, useRef, useCallback, useEffect, CSSProperties } from 'react';
import type { ListPageRequest, ListPageResponse } from 'rocketride';
import type { DashboardResponse, DashboardConnection, DashboardTask, ActivityEvent } from './types';
import { OverviewPanel, ConnectionsPanel, TasksPanel, ActivityPanel } from './components';
import { TabPanel } from 'shell';
import { ContentHeader } from 'shell';
import { TabControl } from 'shell';
import type { ITabPanelPanel } from 'shell';
import type { ViewMenu } from 'shell';
import { commonStyles } from 'shell';

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
	// Fills the space below the top TabControl strip; TabPanel's
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
	/**
	 * Document display name for the page header. When provided, the view
	 * renders a stock {@link ContentHeader} titled with this name (matching
	 * the host's tab title), pinned between the page strip and the scrolling
	 * page bodies. No header renders without it.
	 */
	documentTitle?: string;
	/** Full dashboard snapshot from rrext_dashboard response, or null if not yet loaded. */
	data: DashboardResponse | null;
	/** Activity events pushed from the server (newest first). */
	events: ActivityEvent[];
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
	/**
	 * Controlled active page. When set, the view renders this page and
	 * ignores its internal tab state; page switches (if the strip is shown)
	 * are reported through `onPageChange` instead of applied locally. Hosts
	 * that render their own switcher (monitor-ui's sidebar menu) pair this
	 * with `hideTabs`.
	 */
	activePage?: MonitorPageId;
	/** Fired with the target page id when the user picks a strip tab. */
	onPageChange?: (page: MonitorPageId) => void;
	/**
	 * Hide the top TabControl strip — the host provides the page switcher
	 * (e.g. a sidebar menu) and drives the view via `activePage`.
	 */
	hideTabs?: boolean;
}

/** One of the monitor's four pages — the ids the page switcher selects. */
export type MonitorPageId = 'overview' | 'connections' | 'tasks' | 'activity';

type TabId = MonitorPageId;

/**
 * Per-page header subtitles — "{Page} — {short descriptor}" (the ProjectView
 * DOC_SUBVIEW_SUBTITLES convention).
 */
const PAGE_SUBTITLES: Record<TabId, string> = {
	overview: 'Overview: server health at a glance.',
	connections: 'Connections: every client attached to this server.',
	tasks: 'Tasks: running and recent pipeline tasks.',
	activity: 'Activity: the live server event feed.',
};

// =============================================================================
// COMPONENT
// =============================================================================

const MonitorView: React.FC<IMonitorViewProps> = ({ documentTitle, data, events, onRefresh, listConnections, listTasks, onRefetchReady, activePage, onPageChange, hideTabs }) => {
	const [localTab, setLocalTab] = useState<TabId>('overview');
	// Controlled when the host passes activePage; self-managed otherwise.
	const activeTab = activePage ?? localTab;
	/** Routes a page pick to the controller (host or local state). */
	const selectTab = (id: TabId): void => {
		if (activePage !== undefined) onPageChange?.(id);
		else setLocalTab(id);
	};

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

	// ViewMenu declaration — rendered by this view's own TabControl strip.
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
						<OverviewPanel data={data} events={events} onRefresh={onRefresh} />
					</div>
				),
			},
			connections: {
				content: (
					<div style={commonStyles.tabContent}>
						{/* Snapshot rows back the LOCAL grid; a host fetcher switches
						    it REMOTE (conditional spread keeps the prop truly absent
						    for hosts without one). */}
						<ConnectionsPanel connections={data.connections} {...(listConnections ? { listConnections } : {})} onRefetchReady={handleConnectionsRefetchReady} />
					</div>
				),
			},
			tasks: {
				content: (
					<div style={commonStyles.tabContent}>
						<TasksPanel tasks={data.tasks} {...(listTasks ? { listTasks } : {})} onRefetchReady={handleTasksRefetchReady} />
					</div>
				),
			},
			activity: {
				content: (
					<div style={commonStyles.tabContent}>
						<ActivityPanel events={events} />
					</div>
				),
			},
		};
	}, [data, events, onRefresh, listConnections, listTasks, handleConnectionsRefetchReady, handleTasksRefetchReady]);

	return (
		<div style={styles.root}>
			{/* Page strip — the view renders its own tabs at the very top,
			    unless the host supplies its own switcher (hideTabs). */}
			{!hideTabs && <TabControl menu={viewMenu} activeId={activeTab} onSelect={(id) => selectTab(id as TabId)} />}
			{/* Page title, PINNED with the strip (shell hosts only — see the
			    documentTitle prop); only the panel bodies below scroll. */}
			{documentTitle && <ContentHeader title={documentTitle} subtitle={PAGE_SUBTITLES[activeTab]} />}
			{/* Page bodies fill the space below the strip. */}
			<div style={styles.pageBody}>
				<TabPanel panels={panels} activeId={activeTab} />
			</div>
		</div>
	);
};

export default MonitorView;
