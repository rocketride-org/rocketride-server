// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Message types for communication between the PageMonitorProvider
 * (extension host) and the PageMonitor webview (React component).
 */

import type { DashboardResponse, DashboardEvent, TaskEvent } from 'rocketride';

/** Messages sent FROM the extension host TO the webview. */
export type PageMonitorIncomingMessage = { type: 'dashboardData'; data: DashboardResponse } | { type: 'connectionState'; state: string } | { type: 'taskEvent'; body: TaskEvent } | { type: 'dashboardEvent'; body: DashboardEvent };

/** Messages sent FROM the webview TO the extension host. */
export type PageMonitorOutgoingMessage = { type: 'ready' } | { type: 'refresh' };
