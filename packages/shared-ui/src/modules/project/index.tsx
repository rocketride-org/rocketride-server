// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Project module — Unified project frame for pipeline editing and monitoring.
 */

export { default as ProjectView } from './ProjectView';
export type { IProjectViewProps } from './ProjectView';
export type { IViewProps, ProjectViewMode, ViewState, TaskStatus, TraceEvent, TraceRow } from './types';
export { parseServerEvent } from './utils';
export type { ParsedServerEvent } from './utils';
