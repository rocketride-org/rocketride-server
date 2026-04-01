// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Message types for communication between the PageDashboardProvider
 * (extension host) and the PageDashboard webview (React component).
 */

import type { DashboardResponse } from 'rocketride';

/** Messages sent FROM the extension host TO the webview. */
export type PageDashboardIncomingMessage = { type: 'dashboardData'; data: DashboardResponse } | { type: 'connectionState'; state: string };

/** Messages sent FROM the webview TO the extension host. */
export type PageDashboardOutgoingMessage = { type: 'ready' } | { type: 'refresh' };
