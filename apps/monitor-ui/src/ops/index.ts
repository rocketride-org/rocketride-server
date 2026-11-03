// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// Barrel for the monitor tool's ops — the standard tool-ops layout:
//   types.ts   the protocol maps (coordination of shared state ONLY — plain
//              engine calls go through the realm client)
//   server.ts  the controller-served implementations
//   client.ts  the frame-side typed calls

export type { IDashboardSnapshot, MonitorOps, MonitorStateMap, MonitorEventMap } from './types';
export { serveMonitorOps } from './server';
export type { IMonitorOpsServerDeps } from './server';
export { createMonitorOpsClient } from './client';
export type { IMonitorOpsClient } from './client';
