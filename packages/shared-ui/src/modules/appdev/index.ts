// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// APP BUILDER MODULE — deep-path entry point
// =============================================================================

/**
 * The App Builder view layer. Deliberately NOT exported from the shared-ui
 * main barrel (the deploy-panel precedent — keep the shared singleton's
 * surface lean); hosts import 'shared/modules/appdev' directly, exactly
 * like 'shared/modules/project'.
 */

export { AppBuilderScreen } from './AppBuilderScreen';
export type { IAppBuilderScreenProps } from './AppBuilderScreen';
export { DevelopView } from './DevelopView';
export type { IDevelopViewProps } from './DevelopView';
export { DeployView } from './DeployView';
export type { IDeployViewProps } from './DeployView';
export { StoreView } from './StoreView';
export type { IStoreViewProps } from './StoreView';
export { LogList, LOG_LIST_CAP } from './LogList';
export type { ILogListProps, LogListRow } from './LogList';
export { renderTemplate, TEMPLATE_NAMES } from './templates';
export type { TemplateFile, TemplateName, TemplateVars } from './templates';
export type {
	AppBuilderCapabilities,
	AppBuilderStage,
	AppErrorRow,
	AppEventRow,
	AppStatus,
	AppSummary,
	AppVersionInfo,
	ConsoleRow,
	DevelopPane,
	IAppBuilderHost,
	ListingDraft,
	PreflightCheck,
	PricingTier,
	ReviewTimelineItem,
	RungKind,
	RungPin,
	WatchStatus,
} from './types';
