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
// MonitorProvider — Browser host for the server monitor
// =============================================================================
//
// Thin host for the server monitor singleton view. Dashboard data and activity
// events come from the shared useDashboardData hook (one 3s snapshot interval
// shared across every consumer — admin-ui and rocket-ui), so this page owns no
// snapshot polling or event subscription of its own. It binds the paged list
// fetchers to the shell client so the Connections and Tasks grids run
// server-side (REMOTE mode) and polls their combined refetch every 3 seconds.
//
// Directly mounts <MonitorView> as a React child — no iframe, no postMessage.
// =============================================================================

import React, { useCallback, useRef } from 'react';
import { commonStyles } from 'shell';
import { useShellConnection, useDashboardData, usePolling } from 'shell';
import { MonitorView } from 'shell';
import type { DashboardConnection, DashboardTask, ListPageRequest, ListPageResponse } from 'shell';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Grid refresh cadence (ms) — matches the dashboard hook's 3s poll. */
const GRID_POLL_INTERVAL_MS = 3000;

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: commonStyles.columnFill,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Server monitor page — binds the shared MonitorView to the shell client:
 * snapshot + events from useDashboardData, paged list fetchers for the
 * REMOTE grids, and the 3s combined grid refetch poll.
 */
const MonitorProvider: React.FC = () => {
	const { client, isConnected } = useShellConnection();

	// Shared dashboard snapshot: a single module-level 3s poll plus the activity
	// event subscription, both owned by useDashboardData and shared with every
	// other consumer. Replaces the former local 3-second polling loop and the
	// duplicate shell:event activity subscription this page used to own.
	const { data, events, refresh } = useDashboardData();

	/**
	 * Paged connections fetcher for the shared Connections grid (REMOTE mode).
	 *
	 * @param req - Paging / sort / filter / search arguments from the grid.
	 * @returns The standard list envelope from the server.
	 */
	const listConnections = useCallback(
		async (req: ListPageRequest): Promise<ListPageResponse<DashboardConnection>> => {
			// No client yet (shell still connecting): an empty page — the
			// connection-gated poll refetches as soon as the shell comes up.
			if (!client) return { rows: [], total: 0, page: 1, pageSize: req.page_size ?? 0 };
			return client.listConnections(req);
		},
		[client]
	);

	/**
	 * Paged tasks fetcher for the shared Tasks grid (REMOTE mode).
	 *
	 * @param req - Paging / sort / filter / search arguments from the grid.
	 * @returns The standard list envelope from the server.
	 */
	const listTasks = useCallback(
		async (req: ListPageRequest): Promise<ListPageResponse<DashboardTask>> => {
			// Same shell-connecting guard as listConnections.
			if (!client) return { rows: [], total: 0, page: 1, pageSize: req.page_size ?? 0 };
			return client.listTasks(req);
		},
		[client]
	);

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

	// --- Render --------------------------------------------------------------

	return (
		<div style={styles.container}>
			<MonitorView documentTitle="Monitor" data={data} events={events} isConnected={isConnected} onRefresh={refresh} listConnections={listConnections} listTasks={listTasks} onRefetchReady={handleRefetchReady} />
		</div>
	);
};

export default MonitorProvider;
