// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Server Monitor module — Public API for the server dashboard component.
 *
 * The primary export is the `ServerMonitor` component, which is the single
 * entry point for host applications.
 *
 * ```tsx
 * import ServerMonitor from 'shared/modules/server';
 * <ServerMonitor data={snapshot} events={activity} isConnected={true} />
 * ```
 */

export { default } from './ServerMonitor';
export type { IServerMonitorProps } from './ServerMonitor';
export { parseActivityEvent } from './utils';
export * from './types';
