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
import { useIframeBridge } from './hooks/useIframeBridge';
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

// Workspace-preferences accessor + provider (re-exported from shared) — the ONE
// prefs API every app and shared-ui surface reads/writes through (get/set a key
// in the app's workspace prefs bag). shared-ui sits below shell-ui, so the
// implementation lives there; the shell surfaces it here as the frozen contract.
import { usePrefs, PrefsProvider } from 'shared';

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
import AccountProvider from './providers/AccountProvider';
import SettingsProvider from './providers/SettingsProvider';

// Icons — a DELIBERATE subset of ./icons/BoxIcon: only the glyphs shell chrome
// itself renders are part of the frozen contract. Apps needing other icons take
// them from 'shared' (the full set), which is not contract-bound; every name
// added here is frozen forever, so the surface grows only on demonstrated need.
import { BxPlus, BxEditAlt, BxTrash, BxDesktop, BxGridAlt, BxCog, BxListUl, BxStop, BxPlay, BxHome, BxNote, BxComponent, BxUser, BxRocket, BxLockOpen, BxPurchaseTag, BxChevronRight, BxFolderOpen } from './icons/BoxIcon';

// =============================================================================
// TYPE RE-EXPORTS — standalone types apps import from 'shell-ui'
// =============================================================================
//
// These have no corresponding runtime value in `shellApi`, so they are named
// in the frozen bundle via explicit type re-exports. The prop/return types of
// the value symbols above are captured structurally through `ShellApiShape`.
//
// Known gaps queued for the NEXT freeze (adding a name here is an actionable
// contract change, so they ride the already-planned v3 re-freeze rather than
// minting a version alone): BottomPanelProps, IUsePollingOptions. Until then
// both are reachable structurally via the BottomPanel / usePolling values.
// =============================================================================

// Shell component prop contracts + workspace/config types
export type { ShellAppProps, ShellSidebarProps, AppDescriptor, AppManifestEntry, ShellConfig, ShellApiConfig, WorkspacePrefs, WorkspaceState, AppWorkspaceState, SettingValue, SettingSchema, AppConfiguration, ShellBrandingConfig, ShellThemeConfig, ShellThemeOption, ShellAccountConfig } from './workspace/types';

// Top-level shell + sidebar component prop types
export type { ShellProps } from './components/layout/Shell';
export type { SidebarProps, NavButtonProps } from './components/layout/Sidebar';
export type { ConfirmDialogProps } from './components/layout/ConfirmDialog';

// Workspace context interface + provider props
export type { IWorkspaceContext, IWorkspaceProviderProps } from './workspace/WorkspaceContext';

// The shared RocketRide client — an MF shared singleton the shell serves to
// every app, so its API surface is PART of this contract. Exporting the type
// by name gives it its own per-version floor (Frozen = Current, covariant):
// SDK additions pass, removals/narrowings of anything ever frozen fail
// shell-ui's tsc. The client is deliberately kept INLINED in the frozen
// bundle. It must never appear in an
// input position on this surface — see contract-hold.ts.
export type { RocketRideClient } from 'rocketride';

// Connection manager standalone types
export type { InitOptions, DebugLogEntry } from './connection/connection';

// Auth identity type (ConnectResult aliased as AuthUser)
export type { AuthUser } from './hooks/useAuthUser';

// Event map + connection status/mode/auth-provider types (from shared)
export type { ShellConnectionEventMap as ShellEventMap } from 'shared';
export type { ConnectionStatus, ConnectionMode, IAuthProvider } from 'shared';

// Iframe protocol message types
export type { ShellToIframeMsg, IframeToShellMsg, ShellInitMsg } from './hooks/iframeBridgeProtocol';

// Document component library standalone types.
// `Documents` itself is captured as a constructor via `shellApi.Documents`;
// these are its standalone helper/model types that apps import directly.
export type { Editor, WorkspaceBinding, Document, EditorGroup, SplitOrientation, DocumentsState, LayoutNode, LayoutLeaf, LayoutSplit } from './lib/Documents';
export type { DocTabsProps } from './lib/DocTabs';
export type { DocSplitLayoutProps } from './lib/DocSplitLayout';
export type { DocExplorerProps, DocExplorerConfig, DocEntry, DocEntryChild, DocEntryStatus } from './lib/DocExplorer';
export type { IVirtualFileSystem } from 'shared/modules/explorer/types';

// ViewMenu declaration types (consumed by shared-ui's TabControl/SidebarMenu)
export type { DashboardData } from './hooks/useDashboardData';
export type { ViewMenu, ViewMenuEntry } from 'shared';

// The workspace-prefs accessor shape ({ getPref, setPref }) for usePrefs/PrefsProvider.
export type { IPrefsApi } from 'shared';

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
	useIframeBridge,
	useSubscriptions,
	usePolling,
	useDashboardData,
	useConnectionStatus,
	useShellApiConfig,
	useAppComponent,
	useSidebarContent,
	useClickOutside,
	useFixedPopupPosition,
	usePrefs,

	// Client access + connection manager + connection state
	getClient,
	ConnectionManager,
	ConnectionState,

	// Auth providers
	CloudAuthProvider,
	ApiKeyAuthProvider,

	// Workspace provider + prefs provider
	WorkspaceProvider,
	PrefsProvider,

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
	AccountProvider,
	SettingsProvider,

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

// =============================================================================
// NAMED VALUE EXPORTS — the frozen bundle must MIRROR the runtime module
// =============================================================================
//
// The real shell-ui module (index.ts, served over the MF share scope) exports
// every one of these as a NAMED export, and app code imports them by name
// (`import { DocTabs, useShellConnection } from 'shell-ui'`). Without this
// list the frozen .d.ts — which standalone app repos use AS their 'shell-ui'
// types — exposed the values only through the `shellApi` object, so every
// named value import failed with TS2459 ("declares locally but not
// exported") despite working at runtime. Same members as `shellApi` above;
// additions are append-only, exactly like the object.
export {
	// Hooks
	useShellConnection, useAuthUser, useLogout, useWorkspace, useClient,
	useShellEvent, useIframeBridge, useSubscriptions, usePolling,
	useDashboardData, useConnectionStatus, useShellApiConfig, useAppComponent,
	useSidebarContent, useClickOutside, useFixedPopupPosition, usePrefs,
	// Client access + connection manager + connection state
	getClient, ConnectionManager, ConnectionState,
	// Auth providers
	CloudAuthProvider, ApiKeyAuthProvider,
	// Workspace provider + prefs provider
	WorkspaceProvider, PrefsProvider,
	// Document component library
	Documents, DocTabs, DocSplitLayout, DocExplorer,
	// Top-level shell frame + zone components
	Shell, Sidebar, BottomPanel, DebugPanel,
	// Layout building blocks
	NavButton, ConfirmDialog, PopupRow,
	// Shell-owned overlay pages
	AccountProvider, SettingsProvider,
	// Icons
	BxPlus, BxEditAlt, BxTrash, BxDesktop, BxGridAlt, BxCog, BxListUl,
	BxStop, BxPlay, BxHome, BxNote, BxComponent, BxUser, BxRocket,
	BxLockOpen, BxPurchaseTag, BxChevronRight, BxFolderOpen,
};

/**
 * The compile-time shape of the shell API surface.
 *
 * This is the type frozen by `./builder shell:freeze` into `ShellApiVN`. Any
 * change that removes or narrows a member breaks conformance against a frozen
 * version and fails `tsc --noEmit`.
 */
export type ShellApiShape = typeof shellApi;

// =============================================================================
// EXPORT-LIST SYNC GUARD
// =============================================================================
//
// The named export list above duplicates shellApi's member list, and the two
// MUST stay identical — the frozen bundle mirrors the runtime module only if
// every shellApi member is also a named export. This assertion makes drift a
// compile error that NAMES the forgotten symbol(s): `typeof import('./api')`
// is this module's own value namespace, so any shellApi key missing from it
// survives the Exclude and poisons the assignment below. The freeze pre-check
// runs `tsc --noEmit`, so an out-of-sync surface can never freeze.
type _MissingNamedExports = Exclude<keyof ShellApiShape, keyof typeof import('./api')>;
const _exportsComplete: [_MissingNamedExports] extends [never] ? true : _MissingNamedExports = true;
void _exportsComplete;

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
