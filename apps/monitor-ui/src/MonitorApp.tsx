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
// Polls the server dashboard endpoint every 3 seconds and renders the shared
// MonitorView component. Subscribes to shell:event for real-time activity.
//
// Pattern matches rocket-ui's MonitorPage.tsx.
// =============================================================================

import React, { useEffect, useCallback, useState, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { ShellAppProps } from 'shell-ui';
import { useShellConnection, ConnectionManager, getClient } from 'shell-ui';
import { commonStyles } from 'shared/themes/styles';
import { MonitorView, parseActivityEvent } from 'shared';
import type { DashboardResponse, ActivityEvent } from 'shared';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Dashboard polling interval in milliseconds. */
const POLL_INTERVAL = 3000;

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
 * Polls the `getDashboard()` API every 3 seconds and subscribes to live
 * server events for the activity feed. Renders the shared MonitorView
 * component with the latest data.
 */
const MonitorApp: React.FC<ShellAppProps> = (_props) => {
	const { isConnected } = useShellConnection();
	const [data, setData] = useState<DashboardResponse | null>(null);
	const [events, setEvents] = useState<ActivityEvent[]>([]);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// =========================================================================
	// DASHBOARD FETCH
	// =========================================================================

	/** Fetch the latest dashboard snapshot from the server. */
	const fetchDashboard = useCallback(async () => {
		const client = getClient();
		if (!client || !client.isConnected()) return;
		try {
			const dashboard = await client.getDashboard();
			if (dashboard?.overview) {
				setData(dashboard);
			}
		} catch (err) {
			console.warn('[MonitorApp] Dashboard fetch failed:', err);
		}
	}, []);

	// =========================================================================
	// POLLING WHILE CONNECTED
	// =========================================================================

	useEffect(() => {
		if (!isConnected) {
			if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
			return;
		}

		// Initial fetch, then poll at interval
		fetchDashboard();
		intervalRef.current = setInterval(fetchDashboard, POLL_INTERVAL);

		return () => {
			if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
		};
	}, [isConnected, fetchDashboard]);

	// =========================================================================
	// SERVER EVENT SUBSCRIPTION
	// =========================================================================

	useEffect(() => {
		const unsub = ConnectionManager.getInstance().on('shell:event', ({ event }) => {
			const parsed = parseActivityEvent(event);
			if (parsed) {
				setEvents((prev) => [parsed, ...prev].slice(0, 200));
			}
		});
		return unsub;
	}, []);

	// =========================================================================
	// RENDER
	// =========================================================================

	return (
		<div style={styles.container}>
			<MonitorView
				data={data}
				events={events}
				isConnected={isConnected}
				onRefresh={fetchDashboard}
			/>
		</div>
	);
};

export default MonitorApp;
