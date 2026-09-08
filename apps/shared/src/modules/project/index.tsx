// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Project module — Unified project frame for pipeline editing and monitoring.
 */

export { default as ProjectView } from './ProjectView';
export type { IProjectViewProps } from './ProjectView';
export type { IViewProps, ProjectViewMode, ViewState, TaskStatus, TraceEvent, TraceRow, TraceLevel } from './types';
export { parseServerEvent, isDevLiveEvent, isTeamLiveEvent } from './utils';
export type { ParsedServerEvent } from './utils';

// Run-log continuum delivery + projections (the source-section building
// blocks: session-consumer hook, text log projection, efficiency analysis).
export { useTaskEvents } from './hooks/useTaskEvents';
export type {
	PlayerMode,
	TaskChapter,
	TaskEventMessage,
	TaskEventSession,
	TaskPlayerController,
	TaskPlayerState,
	TaskTimeline,
	TrackWindow,
	UseTaskEventsOptions,
	UseTaskEventsResult,
} from './hooks/useTaskEvents';
export { LogPane } from './components/LogPane';
export type { ILogPaneProps } from './components/LogPane';
export { StatusPane } from './components/StatusPane';
export type { IStatusPaneProps } from './components/StatusPane';
