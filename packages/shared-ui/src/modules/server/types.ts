// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Type definitions for the Server Monitor module.
 *
 * Re-exports dashboard types from the client SDK and defines
 * module-specific UI types.
 */

import type { DashboardEvent as _DashboardEvent, TaskEvent as _TaskEvent } from 'rocketride';

export type { DashboardOverview, DashboardConnection, DashboardTask, DashboardResponse, DashboardEvent, TaskEvent } from 'rocketride';

/** Wrapper for activity events from either channel. */
export type ActivityEvent = { source: 'task'; body: _TaskEvent } | { source: 'dashboard'; body: _DashboardEvent };
