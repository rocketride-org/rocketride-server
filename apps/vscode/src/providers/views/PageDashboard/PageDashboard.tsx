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

import React, { useState } from 'react';
import ServerMonitor from 'shared/modules/server';
import type { DashboardResponse } from 'rocketride';
import { useMessaging } from '../../../shared/util/useMessaging';
import '../../styles/vscode.css';

type IncomingMessage = { type: 'dashboardData'; data: DashboardResponse } | { type: 'connectionState'; state: string };

type OutgoingMessage = { type: 'ready' } | { type: 'refresh' };

export const PageDashboard: React.FC = () => {
	const [data, setData] = useState<DashboardResponse | null>(null);
	const [isConnected, setIsConnected] = useState(true);

	const { sendMessage } = useMessaging<OutgoingMessage, IncomingMessage>({
		onMessage: (message) => {
			switch (message.type) {
				case 'dashboardData':
					setData(message.data);
					break;
				case 'connectionState':
					setIsConnected(message.state === 'connected');
					break;
			}
		},
	});

	return <ServerMonitor data={data} events={[]} isConnected={isConnected} onRefresh={() => sendMessage({ type: 'refresh' })} />;
};
