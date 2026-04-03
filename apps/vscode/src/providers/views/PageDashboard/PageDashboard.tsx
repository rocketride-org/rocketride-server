// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PageDashboard — Thin host wrapper for the <ServerMonitor /> shared component.
 *
 * Receives data from the PageDashboardProvider via useMessaging and passes it
 * as props to the shared-ui ServerMonitor component.
 */

import React, { useState, useCallback } from 'react';
import ServerMonitor, { type ActivityEvent } from 'shared/modules/server';
import type { DashboardResponse } from 'rocketride';
import { useMessaging } from '../../../shared/util/useMessaging';
import '../../styles/vscode.css';
import type { PageDashboardIncomingMessage } from '../../../shared/types/pageDashboard';
type OutgoingMessage = { type: 'ready' } | { type: 'refresh' };

const MAX_EVENTS = 100;

export const PageDashboard: React.FC = () => {
	const [data, setData] = useState<DashboardResponse | null>(null);
	const [events, setEvents] = useState<ActivityEvent[]>([]);
	const [isConnected, setIsConnected] = useState(true);

	const handleMessage = useCallback((message: PageDashboardIncomingMessage) => {
		switch (message.type) {
			case 'dashboardData':
				setData(message.data);
				break;
			case 'connectionState':
				setIsConnected(message.state === 'connected');
				break;
			case 'taskEvent':
				setEvents((prev) => [{ source: 'task' as const, body: message.body, receivedAt: Date.now() / 1000 }, ...prev].slice(0, MAX_EVENTS));
				break;
			case 'dashboardEvent':
				setEvents((prev) => [{ source: 'dashboard' as const, body: message.body, receivedAt: message.body.timestamp }, ...prev].slice(0, MAX_EVENTS));
				break;
		}
	}, []);

	const { sendMessage } = useMessaging<OutgoingMessage, PageDashboardIncomingMessage>({
		onMessage: handleMessage,
	});

	return <ServerMonitor data={data} events={events} isConnected={isConnected} onRefresh={() => sendMessage({ type: 'refresh' })} />;
};
