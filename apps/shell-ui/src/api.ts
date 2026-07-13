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

/// <reference path="../../../packages/shared-ui/src/types/global.d.ts" />
//
// The reference above pulls shared-ui's ambient module declarations (d3, the
// `import.meta.webpackContext` typing, asset imports) into the program when
// `./builder shell:freeze` bundles this entry with dts-bundle-generator, which
// builds its program from this file's import graph and does NOT read the
// tsconfig `files` array. Without it, transitively-reached shared-ui modules
// fail to compile during generation.

// =============================================================================
// shell-ui — curated app-facing API surface (contract entry)
// =============================================================================
//
// This module is the SINGLE curated surface that Module Federation remote apps
// consume from shell-ui. Per the design-owner decision the contract covers
// shell-ui's ENTIRE public export surface (not just the currently-consumed
// subset): every value symbol is gathered into one `shellApi` object and every
// standalone type is named via explicit type re-exports.
//
// `./builder shell:freeze` bundles this file into a frozen, versioned `.d.ts`
// (packages/shell-api/versions/vN.d.ts). `ShellApiShape` is the compile-time
// contract; breaking it must break shell-ui's own `tsc`. Do NOT narrow this
// surface without a freeze — removing a member is a breaking change.
// =============================================================================

// =============================================================================
// VALUE IMPORTS — hooks, client access, classes, components, icons
// =============================================================================

// Hooks
import { useShellConnection } from './connection/ConnectionContext';
import { useAuthUser, useLogout } from './hooks/useAuthUser';
import { useWorkspace } from './workspace/WorkspaceContext';
import { useClient } from './hooks/useClient';
import { useShellEvent } from './hooks/useShellEvent';
import { useSubscriptions } from './hooks/useSubscriptions';
import { usePolling } from './hooks/usePolling';
import { useDashboardData } from './hooks/useDashboardData';
import { useConnectionStatus } from './hooks/useConnectionStatus';
import { useShellApiConfig } from './connection/ShellApiConfigContext';
import { useShellEvents } from './views/useShellEvents';
import { useAppComponent } from './lib/useAppComponent';
import { useSidebarContent } from './components/layout/HostChromeContext';

// Shared hooks re-exported through shell-ui for app convenience
import { useClickOutside } from 'shared/hooks/useClickOutside';
import { useFixedPopupPosition } from 'shared/hooks/useFixedPopupPosition';

// Non-React client access + connection manager singleton
import { getClient } from './lib/getClient';
import { ConnectionManager } from './connection/connection';

// Connection state enum (re-exported from shared)
import { ConnectionState } from 'shared';

// Auth providers
import { CloudAuthProvider } from './auth/CloudAuthProvider';
import { ApiKeyAuthProvider } from './auth/ApiKeyAuthProvider';

// Workspace provider
import { WorkspaceProvider } from './workspace/WorkspaceContext';

// Document component library
import { Documents } from './lib/Documents';
import DocTabs from './lib/DocTabs';
import DocSplitLayout from './lib/DocSplitLayout';
import { DocExplorer } from './lib/DocExplorer';

// Top-level shell frame + zone components
import Shell from './components/layout/Shell';
import Sidebar from './components/layout/Sidebar';
import BottomPanel from './components/layout/BottomPanel';
import DebugPanel from './components/layout/DebugPanel';

// Layout building blocks
import { NavButton } from './components/layout/Sidebar';
import ConfirmDialog from './components/layout/ConfirmDialog';
import { PopupRow } from 'shared/components/PopupRow';

// Shell-owned overlay pages
import AccountPage from './views/account/AccountPage';
import SettingsPage from './views/settings/SettingsPage';

// Icons
import {
	BxPlus,
	BxEditAlt,
	BxTrash,
	BxDesktop,
	BxGridAlt,
	BxCog,
	BxListUl,
	BxStop,
	BxPlay,
	BxHome,
	BxNote,
	BxComponent,
	BxUser,
	BxRocket,
	BxLockOpen,
	BxPurchaseTag,
	BxChevronRight,
	BxFolderOpen,
} from './icons/BoxIcon';

// =============================================================================
// TYPE RE-EXPORTS — standalone types apps import from 'shell-ui'
// =============================================================================
//
// These have no corresponding runtime value in `shellApi`, so they are named
// in the frozen bundle via explicit type re-exports. The prop/return types of
// the value symbols above are captured structurally through `ShellApiShape`.
// =============================================================================

// Shell component prop contracts + workspace/config types
export type {
	ShellAppProps,
	ShellSidebarProps,
	AppDescriptor,
	AppManifestEntry,
	ShellConfig,
	ShellApiConfig,
	WorkspacePrefs,
	WorkspaceState,
	AppWorkspaceState,
	AppSettingDefinition,
	ShellBrandingConfig,
	ShellThemeConfig,
	ShellThemeOption,
	ShellAccountConfig,
} from './workspace/types';

// Top-level shell + sidebar component prop types
export type { ShellProps } from './components/layout/Shell';
export type { SidebarProps, NavButtonProps } from './components/layout/Sidebar';
export type { ConfirmDialogProps } from './components/layout/ConfirmDialog';

// Workspace context interface
export type { IWorkspaceContext } from './workspace/WorkspaceContext';

// Connection manager standalone types
export type { InitOptions, DebugLogEntry } from './connection/connection';

// Auth identity type (ConnectResult aliased as AuthUser)
export type { AuthUser } from './hooks/useAuthUser';

// Event map + connection status/mode/auth-provider types (from shared)
export type { ShellConnectionEventMap as ShellEventMap } from 'shared';
export type { ConnectionStatus, ConnectionMode, IAuthProvider } from 'shared';

// Iframe protocol message types
export type { ShellToIframeMsg, IframeToShellMsg, ShellInitMsg } from './views/ShellIframeProtocol';

// Document component library standalone types.
// `Documents` itself is captured as a constructor via `shellApi.Documents`;
// these are its standalone helper/model types that apps import directly.
export type {
	Editor,
	WorkspaceBinding,
	Document,
	EditorGroup,
	SplitOrientation,
	DocumentsState,
	LayoutNode,
	LayoutLeaf,
	LayoutSplit,
} from './lib/Documents';
export type { DocTabsProps } from './lib/DocTabs';
export type { DocSplitLayoutProps } from './lib/DocSplitLayout';
export type { DocExplorerProps, DocExplorerConfig, DocEntry, DocEntryChild, DocEntryStatus } from './lib/DocExplorer';
export type { IVirtualFileSystem } from 'shared/modules/explorer/types';

// ViewMenu declaration types (consumed by shared-ui's PageViewControl/SidebarMenu)
export type { DashboardData } from './hooks/useDashboardData';
export type { ViewMenu, ViewMenuEntry } from 'shared';

// =============================================================================
// SHELL API SURFACE
// =============================================================================

/**
 * The curated set of value symbols shell-ui exposes to remote apps.
 *
 * Per the design-owner decision this covers shell-ui's ENTIRE value export
 * surface. The object is frozen at build time so its type — `ShellApiShape` —
 * becomes the versioned contract enforced against shell-ui's own compilation.
 */
export const shellApi = {
	// Hooks
	useShellConnection,
	useAuthUser,
	useLogout,
	useWorkspace,
	useClient,
	useShellEvent,
	useShellEvents,
	useSubscriptions,
	usePolling,
	useDashboardData,
	useConnectionStatus,
	useShellApiConfig,
	useAppComponent,
	useSidebarContent,
	useClickOutside,
	useFixedPopupPosition,

	// Client access + connection manager + connection state
	getClient,
	ConnectionManager,
	ConnectionState,

	// Auth providers
	CloudAuthProvider,
	ApiKeyAuthProvider,

	// Workspace provider
	WorkspaceProvider,

	// Document component library
	Documents,
	DocTabs,
	DocSplitLayout,
	DocExplorer,

	// Top-level shell frame + zone components
	Shell,
	Sidebar,
	BottomPanel,
	DebugPanel,

	// Layout building blocks
	NavButton,
	ConfirmDialog,
	PopupRow,

	// Shell-owned overlay pages
	AccountPage,
	SettingsPage,

	// Icons
	BxPlus,
	BxEditAlt,
	BxTrash,
	BxDesktop,
	BxGridAlt,
	BxCog,
	BxListUl,
	BxStop,
	BxPlay,
	BxHome,
	BxNote,
	BxComponent,
	BxUser,
	BxRocket,
	BxLockOpen,
	BxPurchaseTag,
	BxChevronRight,
	BxFolderOpen,
} as const;

/**
 * The compile-time shape of the shell API surface.
 *
 * This is the type frozen by `./builder shell:freeze` into `ShellApiVN`. Any
 * change that removes or narrows a member breaks conformance against a frozen
 * version and fails `tsc --noEmit`.
 */
export type ShellApiShape = typeof shellApi;

// SHELL_API_VERSION lives in ./apiver.ts (its own file) so `shell:freeze` can
// auto-write it and the app registration step can read it — and so it never
// enters this frozen surface. shell-ui's index re-exports it from there.

/**
 * Returns the curated shell API surface.
 *
 * Apps call this (via shell-ui's public export) to obtain every shell-provided
 * hook, helper, class, component, and icon through one typed object rather than
 * importing each symbol individually.
 *
 * @returns The frozen `shellApi` object.
 */
export function getShellApi(): ShellApiShape {
	return shellApi;
}
