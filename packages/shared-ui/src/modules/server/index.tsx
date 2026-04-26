// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Server Monitor module — Public API for the server dashboard component.
 *
 * The primary export is the `MonitorView` component, which is the single
 * entry point for host applications.
 *
 * ```tsx
 * import MonitorView from 'shared/modules/server';
 * <MonitorView data={snapshot} events={activity} isConnected={true} />
 * ```
 */

export { default } from './MonitorView';
export type { IMonitorViewProps } from './MonitorView';
export { parseActivityEvent } from './utils';
export * from './types';
