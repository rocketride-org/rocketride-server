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
// activity feed from the shared useDashboardData hook (shell-ui), and binding
// the paged list fetchers to the shell client so the Connections and Tasks
// grids run server-side (REMOTE mode). Pattern matches rocket-ui's
// MonitorPage.tsx.
// =============================================================================

import React, { useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { ShellAppProps } from 'shell-ui';
import { useShellConnection, useDashboardData, usePolling } from 'shell-ui';
import { commonStyles } from 'shared/themes/styles';
import { MonitorView } from 'shared';
import type { DashboardConnection, DashboardTask, ListPageRequest, ListPageResponse } from 'shared';

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
 * useDashboardData hook (shell-ui), which polls `getDashboard()` every 3
 * seconds and subscribes to live server events through the shell client.
 * Renders the shared MonitorView with the latest data, plus the paged list
 * fetchers bound to the shell client: the Connections and Tasks grids page,
 * sort, filter, and search server-side, and this host polls their combined
 * refetch every 3 seconds (the admin views' grid pattern).
 */
const MonitorApp: React.FC<ShellAppProps> = (_props) => {
	const { client, isConnected } = useShellConnection();

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
		if (!client) return { rows: [], total: 0, page: 1, pageSize: req.page_size ?? 0 };
		return client.listConnections(req);
	}, [client]);

	/**
	 * Paged tasks fetcher for the shared Tasks grid (REMOTE mode).
	 *
	 * @param req - Paging / sort / filter / search arguments from the grid.
	 * @returns The standard list envelope from the server.
	 */
	const listTasks = useCallback(async (req: ListPageRequest): Promise<ListPageResponse<DashboardTask>> => {
		// Same shell-connecting guard as listConnections.
		if (!client) return { rows: [], total: 0, page: 1, pageSize: req.page_size ?? 0 };
		return client.listTasks(req);
	}, [client]);

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
			/>
		</div>
	);
};

export default MonitorApp;
