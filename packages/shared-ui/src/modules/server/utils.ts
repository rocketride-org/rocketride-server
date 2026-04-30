// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Server event parsing utilities for ServerMonitor hosts.
 *
 * Extracts activity events from raw server WebSocket events.
 * Used by both the rocket-ui provider (direct mount) and the VS Code bridge.
 */

import type { ActivityEvent } from './types';

// =============================================================================
// PARSER
// =============================================================================

/**
 * Parse a raw server event into a monitor ActivityEvent.
 *
 * @param raw - Raw event object from the server WebSocket.
 * @returns ActivityEvent if the event is dashboard or task related, null otherwise.
 */
export function parseActivityEvent(raw: unknown): ActivityEvent | null {
	const msg = raw as Record<string, unknown> | null;
	if (typeof msg?.event === 'string' && typeof msg.body === 'object' && msg.body !== null) {
		if (msg.event === 'apaevt_dashboard') {
			return { source: 'dashboard', body: msg.body, receivedAt: Date.now() } as ActivityEvent;
		}
		if (msg.event === 'apaevt_task') {
			return { source: 'task', body: msg.body, receivedAt: Date.now() } as ActivityEvent;
		}
	}
	return null;
}
