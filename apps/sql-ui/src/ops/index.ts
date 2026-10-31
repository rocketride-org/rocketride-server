// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// Barrel for the sql tool's ops — the standard tool-ops layout:
//   types.ts   the protocol maps (coordination of shared state ONLY — plain
//              engine calls go through the realm client)
//   server.ts  the controller-served implementations
//   client.ts  the frame-side typed calls

export type { SqlOps, SqlStateMap, SqlEventMap, SavedSqlConnection } from './types';
export { serveSqlOps } from './server';
export { createSqlOpsClient } from './client';
export type { ISqlOpsClient } from './client';
