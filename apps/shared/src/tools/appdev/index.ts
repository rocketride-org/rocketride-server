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
// TOOLS/APPDEV — the App Builder tool (sidebar-as-controller)
// =============================================================================

export { scanWorkspaceApps, appIconDataUri, buildWorkspaceAppRows, APP_MARKER_GLOB, APP_SCAN_EXCLUDE, APP_BINDING_WATCH_GLOBS, APP_RESCAN_DEBOUNCE_MS, MAX_README_IMAGE_BYTES } from './scan';
export type { IScannedWorkspaceApp, IWorkspaceAppRow } from './scan';
export { startWorkspaceAppDiscovery } from './controller';

// ── Host-safe logic + contracts (no JSX anywhere below) ─────────────────────
export { renderTemplate, TEMPLATE_NAMES } from './templates';
export type { FrameOptions, TemplateFile, TemplateName, TemplateVars } from './templates';
export { toHistoryEntries, toRungPins, toVersionInfos, walkDeploymentHistory } from './wire';
export { createBusAppBuilderHost } from './busHost';
export type { IAppBuilderBus, IBusAppBuilderHostOptions } from './busHost';
export type { WireHistoryRow, WirePin, WireRailEntry } from './wire';
export { runListingPreflight } from './preflight';
export type { PreflightIO } from './preflight';
export { applyListing, projectListing } from './listing';
export type { PackageJsonLike } from './listing';
export { probePackage } from './compatProbe';
export type { CompatVerdict, ProbeOptions } from './compatProbe';
export type {
	AppBuilderCapabilities,
	AppBuilderStage,
	AppErrorRow,
	AppEventRow,
	AppHistoryEntry,
	AppStatus,
	AppSummary,
	AppVersionInfo,
	BuildStatusTick,
	ConsoleRow,
	DesignPane,
	IAppBuilderHost,
	ListingDraft,
	PreflightCheck,
	BillingPlan,
	RungKind,
	RungPin,
	WatchStatus,
} from './types';
export type { AppListItem, AppBuilderSidebar } from './sidebarTypes';

// The VIEW LAYER (JSX) lives behind the deep entry './views' — this barrel
// stays host-safe: the VS Code extension host compiles it without JSX, so
// nothing exported here may pull a .tsx module.
