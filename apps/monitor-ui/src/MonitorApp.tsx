// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// MONITOR APP — Main client area component
// =============================================================================
//
// Renders the shared MonitorView, sourcing the 3s dashboard snapshot and live
// activity feed from the shared useDashboardData hook (shell), and binding
// the paged list fetchers to the shell client so the Connections and Tasks
// grids run server-side (REMOTE mode). Pattern matches rocket-ui's
// MonitorPage.tsx.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { DevToolProps, ShellAppProps } from 'shell';
import { ConnectionManager, useShellConnection, useDashboardData, usePolling, AppLayout, createToolChannel, createToolController, typedToolChannel, useConnectionReady, useToolState } from 'shell';
import { commonStyles } from 'shell';
import { MonitorView } from 'shell';
import type { DashboardConnection, DashboardTask, ListPageRequest, ListPageResponse, MonitorPageId } from 'shell';
import type { IDashboardSnapshot, MonitorOps, MonitorStateMap } from './ops';
import { MonitorSidebar } from './MonitorSidebar';
import type { MonitorPeerMessage } from './MonitorSidebar';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Grid refresh cadence (ms) — matches the dashboard hook's 3s poll. */
const GRID_POLL_INTERVAL_MS = 3000;

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		...commonStyles.columnFill,
	} as CSSProperties,

};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Server Monitor app — client area.
 *
 * Sources the dashboard snapshot and activity feed from the shared
 * useDashboardData hook (shell), which polls `getDashboard()` every 3
 * seconds and subscribes to live server events through the shell client.
 * Renders the shared MonitorView with the latest data, plus the paged list
 * fetchers bound to the shell client: the Connections and Tasks grids page,
 * sort, filter, and search server-side, and this host polls their combined
 * refetch every 3 seconds (the admin views' grid pattern).
 */
/** Props for {@link MonitorSurface} — host-controlled page selection. */
export interface IMonitorSurfaceProps {
	/** The active page (the host's sidebar menu drives it). */
	page: MonitorPageId;
}

/**
 * The monitor surface — dashboard + grids, no app chrome and NO tab strip
 * (navigation moved to the sidebar menu, 2026-10-14). Shared by the full app
 * (inside its AppLayout) and the devToolFrame mount, where a host workbench
 * renders it directly. All data flows through the shell connection
 * singleton, which the host has connected before mounting.
 */
export const MonitorSurface: React.FC<IMonitorSurfaceProps> = ({ page }) => {
	const { isConnected } = useShellConnection();
	// Engine access rides the SHELL BUS (brokered client.* ops).
	const cm = ConnectionManager.getInstance();

	// Shared 3s dashboard snapshot + activity feed (module-level singleton hook,
	// so data survives view switches without re-fetching).
	const { data, events, refresh } = useDashboardData();

	/**
	 * Paged connections fetcher for the shared Connections grid (REMOTE mode).
	 *
	 * @param req - Paging / sort / filter / search arguments from the grid.
	 * @returns The standard list envelope from the server.
	 */
	const listConnections = useCallback(async (req: ListPageRequest): Promise<ListPageResponse<DashboardConnection>> => {
		// No client yet (shell still connecting): an empty page — the
		// connection-gated poll refetches as soon as the shell comes up.
		if (!cm.isConnected()) return { rows: [], total: 0, page: 1, pageSize: req.page_size ?? 0 };
		return cm.request('client.listConnections', req) as Promise<ListPageResponse<DashboardConnection>>;
	}, [cm]);

	/**
	 * Paged tasks fetcher for the shared Tasks grid (REMOTE mode).
	 *
	 * @param req - Paging / sort / filter / search arguments from the grid.
	 * @returns The standard list envelope from the server.
	 */
	const listTasks = useCallback(async (req: ListPageRequest): Promise<ListPageResponse<DashboardTask>> => {
		// Same shell-connecting guard as listConnections.
		if (!cm.isConnected()) return { rows: [], total: 0, page: 1, pageSize: req.page_size ?? 0 };
		return cm.request('client.listTasks', req) as Promise<ListPageResponse<DashboardTask>>;
	}, [cm]);

	// Combined remote-grid refetch handed up by MonitorView; polled at the
	// same 3s cadence as the dashboard snapshot so the current page of each
	// grid silently refreshes (no page reset).
	const refetchRef = useRef<() => void>(() => {});
	/** Stores MonitorView's combined refetch trigger. */
	const handleRefetchReady = useCallback((refetch: () => void) => {
		refetchRef.current = refetch;
	}, []);
	/** Poll tick: silently re-request the current page of the remote grids. */
	const pollGrids = useCallback(() => {
		refetchRef.current();
	}, []);
	usePolling(pollGrids, GRID_POLL_INTERVAL_MS);

	// =========================================================================
	// RENDER
	// =========================================================================

	return (
		<div style={styles.container}>
			<MonitorView
				data={data}
				events={events}
				isConnected={isConnected}
				onRefresh={refresh}
				listConnections={listConnections}
				listTasks={listTasks}
				onRefetchReady={handleRefetchReady}
				activePage={page}
				hideTabs
			/>
		</div>
	);
};

/**
 * Server Monitor app — the monitor surface inside the app chrome, with the
 * page menu in the sidebar (replacing the old top tab strip) and the status
 * bar below.
 */
const MonitorApp: React.FC<ShellAppProps> = (_props) => {
	const [page, setPage] = useState<MonitorPageId>('overview');
	return (
		<AppLayout sidebar={<MonitorSidebar activeId={page} onSelect={setPage} />} showStatus>
			<MonitorSurface page={page} />
		</AppLayout>
	);
};

// =============================================================================
// DEV-TOOL FRAME — the surface in a host workbench, page-synced over peer
// =============================================================================

/**
 * The monitor surface as a host-mounted devToolFrame: page selections arrive
 * from the tool's sidebar mount over the peer channel (user actions only —
 * the two mounts may be isolated documents), and this frame PUSHES its page
 * on mount and on every change; the host retains the last push so a
 * reloaded sidebar highlights correctly without asking.
 */
export const MonitorDevToolFrame: React.FC<DevToolProps> = ({ peer, channel }) => {
	const [page, setPage] = useState<MonitorPageId>('overview');

	// Apply sidebar selections.
	useEffect(
		() =>
			peer.subscribe((message) => {
				const msg = message as MonitorPeerMessage;
				if (msg && msg.op === 'page') setPage(msg.page);
			}),
		[peer]
	);

	// Push the current page — on mount and on every change.
	useEffect(() => {
		peer.post({ op: 'page', page } satisfies MonitorPeerMessage);
	}, [peer, page]);

	// THIS FRAME HOLDS NO ROCKETRIDE CLIENT. The controller (the tool's
	// sidebar mount) polls the dashboard on its own connection and publishes
	// the snapshot as the retained 'dashboard' topic; the two remote grids
	// page through correlated controller ops; enablement is the host's
	// `host:connection` system topic.
	const toolChannel = useMemo(() => typedToolChannel<MonitorStateMap>(channel ?? createToolChannel(peer)), [channel, peer]);
	const ready = useConnectionReady(toolChannel);
	const dash = useToolState(toolChannel, 'dashboard') ?? { data: null, events: [] };

	const call = useMemo(() => createToolController<MonitorOps>(peer), [peer]);
	const listConnections = useCallback(async (req: ListPageRequest): Promise<ListPageResponse<DashboardConnection>> => {
		if (!ready) return { rows: [], total: 0, page: 1, pageSize: req.page_size ?? 0 };
		return call('monitor.listConnections', req);
	}, [call, ready]);
	const listTasks = useCallback(async (req: ListPageRequest): Promise<ListPageResponse<DashboardTask>> => {
		if (!ready) return { rows: [], total: 0, page: 1, pageSize: req.page_size ?? 0 };
		return call('monitor.listTasks', req);
	}, [call, ready]);
	const refresh = useCallback(() => {
		void call('monitor.refresh', {}).catch(() => undefined);
	}, [call]);

	// Same silent 3s page re-request the in-app surface runs.
	const refetchRef = useRef<() => void>(() => {});
	const handleRefetchReady = useCallback((refetch: () => void) => { refetchRef.current = refetch; }, []);
	const pollGrids = useCallback(() => { refetchRef.current(); }, []);
	usePolling(pollGrids, GRID_POLL_INTERVAL_MS);

	return (
		<div style={styles.container}>
			<MonitorView
				data={dash.data}
				events={dash.events}
				isConnected={ready}
				onRefresh={refresh}
				listConnections={listConnections}
				listTasks={listTasks}
				onRefetchReady={handleRefetchReady}
				activePage={page}
				hideTabs
			/>
		</div>
	);
};

export default MonitorApp;
