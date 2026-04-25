// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

/**
 * Main entry point for the shared-ui package.
 *
 * Exports pure presentation components and shared utilities.
 * Transport / messaging logic lives in the VS Code extension, not here.
 */

// --- Project module (pipeline editor) ----------------------------------------
export { ProjectView } from './modules/project';
export type { IProjectViewProps } from './modules/project';
export { parseServerEvent } from './modules/project';
export type { ParsedServerEvent } from './modules/project';
export type { IViewProps, ProjectViewMode, ViewState, TaskStatus, TraceEvent, TraceRow } from './modules/project';

// --- Server module (dashboard monitor) ---------------------------------------
export { default as ServerMonitor } from './modules/server';
export type { IServerMonitorProps } from './modules/server';
export { parseActivityEvent } from './modules/server';
export type { DashboardResponse, DashboardOverview, DashboardConnection, DashboardTask, DashboardEvent, TaskEvent, ActivityEvent } from './modules/server';

// --- Sidebar module (unified sidebar) ----------------------------------------
export { SidebarMain } from './modules/sidebar/SidebarMain';
export type { ISidebarMainProps, ProjectEntry, ProjectSource, DirEntry, ActiveTaskState, UnknownTask, ConnectionInfo } from './modules/sidebar/types';

// --- Shared types ------------------------------------------------------------
export type { IProject, IValidateResponse, IServiceCatalog } from './types/project';

// --- Supplementary components ------------------------------------------------
export { default as EndpointInfoModal } from './components/pipeline-actions/EndpointInfoModal';
export type { IEndpointInfo as EndpointInfo } from './components/pipeline-actions/PipelineActions';
export { appendAuthQueryParam, buildIntegrationExamples } from './components/pipeline-actions/endpointIntegrationExamples';
export type { IntegrationTabId } from './components/pipeline-actions/endpointIntegrationExamples';

export * from './components/BoxIcon';

export { TabPanel } from './components/tab-panel/TabPanel';
export type { ITabPanelTab, ITabPanelProps } from './components/tab-panel/TabPanel';
