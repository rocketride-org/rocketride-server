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
// TOOLS/APPDEV — the VIEW LAYER (JSX deep entry)
// =============================================================================
//
// Deliberately split from the package index: the VS Code extension host
// imports the index (scan/discovery/wire — no JSX); webview and in-shell
// surfaces import this for the React components.

export { AppDevSidebarPanel } from '../AppDevSidebarPanel';
export type { IAppDevSidebarPanelProps } from '../AppDevSidebarPanel';
export { AppBuilderScreen } from './builder/AppBuilderScreen';
export type { IAppBuilderScreenProps } from './builder/AppBuilderScreen';
export { DashboardView } from './builder/panels/dashboard/DashboardView';
export type { IDashboardViewProps } from './builder/panels/dashboard/DashboardView';
export { DesignView } from './builder/panels/design/DesignView';
export type { IDesignViewProps } from './builder/panels/design/DesignView';
export { PackageView } from './builder/panels/package/PackageView';
export type { IPackageViewProps } from './builder/panels/package/PackageView';
export { DeployView } from './builder/panels/deploy/DeployView';
export type { IDeployViewProps } from './builder/panels/deploy/DeployView';
export { StoreView } from './builder/panels/store/StoreView';
export type { IStoreViewProps } from './builder/panels/store/StoreView';
export { LogList, LOG_LIST_CAP } from './builder/panels/design/panels/console/LogList';
export type { ILogListProps, LogListRow } from './builder/panels/design/panels/console/LogList';
export { NewAppForm, deriveDisplayName } from './new-app/NewAppForm';
export type { INewAppFormProps, NewAppIdentity } from './new-app/NewAppForm';
export { ComponentGallery, KnobsPanel, GALLERY_ENTRIES, GALLERY_GROUPS } from './builder/panels/design/panels/components';
export type {
	GalleryGroup,
	IGalleryDemoProps,
	IGalleryEntry,
	IGalleryKnob,
	IGalleryPropRow,
	IKnobsPanelProps,
	KnobValue,
	KnobValues,
} from './builder/panels/design/panels/components';
