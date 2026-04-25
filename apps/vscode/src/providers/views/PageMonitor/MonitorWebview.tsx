// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * MonitorWebview — VS Code webview bridge for the server monitor.
 *
 * Receives messages from the extension host via useMessaging, manages local
 * state, and renders <ServerMonitor> with props. User actions flow back as
 * messages to the extension host.
 *
 * Architecture:
 *   MonitorHost (Node.js) ↔ postMessage ↔ MonitorWebview (browser) → ServerMonitor (pure UI)
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

import { applyTheme } from 'shared/themes';
import { ServerMonitor, parseActivityEvent } from 'shared';
import type { DashboardResponse, ActivityEvent } from 'shared';
import { useMessaging } from '../hooks/useMessaging';
import type { MonitorHostToWebview, MonitorWebviewToHost } from '../types';

// =============================================================================
// COMPONENT
// =============================================================================

const MonitorWebview: React.FC = () => {
	// --- State (populated from host messages) ---------------------------------

	const [data, setData] = useState<DashboardResponse | null>(null);
	const [events, setEvents] = useState<ActivityEvent[]>([]);
	const [isConnected, setIsConnected] = useState(false);

	const sendMessageRef = useRef<(msg: MonitorWebviewToHost) => void>(() => {});

	// --- Messaging ------------------------------------------------------------

	const handleMessage = useCallback((message: MonitorHostToWebview) => {
		switch (message.type) {
			case 'shell:init':
				if (message.theme) applyTheme(message.theme);
				setIsConnected(message.isConnected);
				sendMessageRef.current({ type: 'view:initialized' });
				break;
			case 'shell:themeChange':
				applyTheme(message.tokens);
				break;
			case 'shell:connectionChange':
				setIsConnected(message.isConnected);
				break;
			case 'server:event': {
				const event = parseActivityEvent(message.event);
				if (event) setEvents((prev) => [event, ...prev].slice(0, 200));
				break;
			}
			case 'monitor:dashboard':
				setData(message.data);
				break;
		}
	}, []);

	const { sendMessage } = useMessaging<MonitorWebviewToHost, MonitorHostToWebview>({
		onMessage: handleMessage,
	});
	useEffect(() => {
		sendMessageRef.current = sendMessage;
	}, [sendMessage]);

	// --- Callbacks → outgoing messages ---------------------------------------

	const handleRefresh = useCallback(() => {
		sendMessage({ type: 'monitor:refresh' });
	}, [sendMessage]);

	// --- Render --------------------------------------------------------------

	return <ServerMonitor data={data} events={events} isConnected={isConnected} onRefresh={handleRefresh} />;
};

export default MonitorWebview;
