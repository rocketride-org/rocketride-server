// =============================================================================
// MonitorPage — Shared iframe/webview content for the server monitor
// =============================================================================
//
// Works in both VS Code webviews and browser iframes via useMessaging.
// Protocol: standard shell:* messages + monitor:* app-specific messages.
// =============================================================================

import React, { useState, useCallback, useRef } from 'react';
import ServerMonitor from './ServerMonitor';
import type { ActivityEvent, DashboardResponse } from './types';
import { applyTheme } from '../../themes';
import { useMessaging } from '../../hooks/useMessaging';

// =============================================================================
// TYPES
// =============================================================================

type MonitorOutgoing = { type: 'view:ready' } | { type: 'view:initialized' } | { type: 'monitor:refresh' };

type MonitorIncoming = { type: 'shell:init'; theme: Record<string, string>; isConnected: boolean } | { type: 'shell:themeChange'; tokens: Record<string, string> } | { type: 'shell:connectionChange'; isConnected: boolean } | { type: 'server:event'; event: unknown } | { type: 'monitor:dashboard'; data: DashboardResponse };

// =============================================================================
// HELPERS
// =============================================================================

function parseActivityEvent(raw: unknown): ActivityEvent | null {
	const msg = raw as Record<string, any>;
	if (msg?.event === 'apaevt_dashboard' && msg.body) {
		return { source: 'dashboard', body: msg.body, receivedAt: Date.now() } as ActivityEvent;
	}
	if (msg?.event === 'apaevt_task' && msg.body) {
		return { source: 'task', body: msg.body, receivedAt: Date.now() } as ActivityEvent;
	}
	return null;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const MonitorPage: React.FC = () => {
	const [data, setData] = useState<DashboardResponse | null>(null);
	const [events, setEvents] = useState<ActivityEvent[]>([]);
	const [isConnected, setIsConnected] = useState(false);
	const sendMessageRef = useRef<(msg: MonitorOutgoing) => void>(() => {});

	const handleMessage = useCallback((message: MonitorIncoming) => {
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

	const { sendMessage } = useMessaging<MonitorOutgoing, MonitorIncoming>({
		onMessage: handleMessage,
	});
	sendMessageRef.current = sendMessage;

	const handleRefresh = useCallback(() => {
		sendMessage({ type: 'monitor:refresh' });
	}, [sendMessage]);

	return <ServerMonitor data={data} events={events} isConnected={isConnected} onRefresh={handleRefresh} />;
};
