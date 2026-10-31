// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// TOOLS/PIPELINES — the Pipelines tool (sidebar-as-controller)
// =============================================================================

export { parsePipelineContent, getSourceComponents, findComponent } from './utils/parse';
export type { Pipeline, PipelineComponent, ParsedPipelineFile, ParsedSourceComponent, ServiceClassInfo } from './utils/parse';
export { startPipelineDiscovery, PIPELINE_FILE_GLOBS, PIPELINE_SCAN_EXCLUDE, PIPELINE_RESCAN_DEBOUNCE_MS } from './sidebar/discovery';
export type { IPipelineDiscovery, IPipelineDiscoveryOptions } from './sidebar/discovery';

// ── The view and its host-facing surface (was tools/pipelines/project) ──────
// ProjectView plus the types and event helpers the HOSTS import to mount and
// drive it. `project/` dissolved in the 2026-10-19 restructure: the view sits
// at the tool root and this index is its only public face.
export { default as ProjectView } from './ProjectView';
export type { IProjectViewProps } from './ProjectView';
export type { IViewProps, ProjectViewMode, ViewState, TaskStatus, TraceEvent, TraceRow, TraceLevel } from './types';
export { parseServerEvent, isDevLiveEvent, isTeamLiveEvent } from './hostEvents';
export type { ParsedServerEvent } from './hostEvents';
export { useTaskEvents } from './panels/development/hooks/useTaskEvents';
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
} from './panels/development/hooks/useTaskEvents';
export { LogPane } from './panels/development/panels/log/LogPane';
export type { ILogPaneProps } from './panels/development/panels/log/LogPane';
export { StatusPane } from './panels/development/panels/status/StatusPane';
export type { IStatusPaneProps } from './panels/development/panels/status/StatusPane';
