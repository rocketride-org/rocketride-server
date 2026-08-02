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
// shell — public API
// =============================================================================

// =============================================================================
// TYPES
// =============================================================================

// Shell component prop contracts — used by apps implementing App/Sidebar
export type { ShellAppProps, ShellSidebarProps } from './components/workspace/types';

// Workspace and shell configuration types
export type { WorkspacePrefs, WorkspaceState, AppWorkspaceState, AppManifestEntry, AppDescriptor, SettingValue, SettingSchema, AppConfiguration, ShellConfig, ShellBrandingConfig, ShellThemeConfig, ShellThemeOption, ShellAccountConfig, ShellApiConfig } from './components/workspace/types';

// Event bus type map — ShellEventMap re-exported from the shared contract
export type { ShellConnectionEventMap as ShellEventMap } from './types/shell';
export type { DebugLogEntry } from './connection/connection';

// Connection manager class (singleton via getInstance())
export { ConnectionManager } from './connection/connection';
export type { InitOptions } from './connection/connection';

// Auth providers
export { CloudAuthProvider } from './auth/CloudAuthProvider';
export { ApiKeyAuthProvider } from './auth/ApiKeyAuthProvider';

// Connection state types (re-exported from shared for convenience)
export { ConnectionState } from './types/connection';
export type { ConnectionStatus, ConnectionMode, IAuthProvider } from './types/connection';

// Convenience: non-React access to the RocketRide client singleton.
// Apps should prefer ConnectionManager.getInstance().getClient() directly.
export { getClient } from './util/getClient';

// Workspace context interface
export type { IWorkspaceContext } from './components/workspace/WorkspaceContext';

// =============================================================================
// CONNECTION
// =============================================================================

// Context-based hook for plugin micro-frontends to access the shell's connection
export { useShellConnection } from './connection/ConnectionContext';

// Hook for reading the shell's API configuration
export { useShellApiConfig } from './connection/ShellApiConfigContext';

// Typed event subscription with automatic cleanup
export { useShellEvent } from './hooks/useShellEvent';

// Connection-aware interval polling
export { usePolling } from './hooks/usePolling';
export type { IUsePollingOptions } from './hooks/usePolling';

// Shared 3s dashboard snapshot + live activity events (module-level singleton)
export { useDashboardData } from './hooks/useDashboardData';
export type { DashboardData } from './hooks/useDashboardData';

// Null-safe client access (only returns client when connected)
export { useClient } from './hooks/useClient';

// Reactive ConnectionStatus hook
export { useConnectionStatus } from './hooks/useConnectionStatus';

// =============================================================================
// WORKSPACE
// =============================================================================

// Provider that owns the workspace state tree and the hook for consuming it
export { WorkspaceProvider, useWorkspace } from './components/workspace/WorkspaceContext';

// =============================================================================
// LAYOUT COMPONENTS
// =============================================================================

// Top-level shell frame component
export { default as Shell } from './components/layout/Shell';
export type { ShellProps } from './components/layout/Shell';

// Collapsible panel rendered below the main content area
export { default as BottomPanel } from './components/layout/BottomPanel';

// Modal confirmation dialog
// The SURFACE ConfirmDialog is the stock modal one (matches api.ts — the
// layout-local dialog is shell-internal chrome only).
export { ConfirmDialog } from './components/modal/ConfirmDialog';

// Sidebar component
export { default as Sidebar } from './components/layout/Sidebar';
export type { SidebarProps } from './components/layout/Sidebar';

// Sidebar building blocks
export { NavButton } from './components/layout/Sidebar';
export { PopupRow } from './components/PopupRow';
export { useClickOutside } from './hooks/useClickOutside';
export { useFixedPopupPosition } from './hooks/useFixedPopupPosition';

// Debug panel
export { default as DebugPanel } from './components/layout/DebugPanel';

// =============================================================================
// HOST CHROME — opt-in sidebar-content registration
// =============================================================================

// Declare sidebar content for the calling view; the shell frame mounts it in
// the sidebar's scrolling slot (rendered even while collapsed — components
// inside read shared-ui's useSidebarCollapsed to pick their collapsed form).
export { useSidebarContent } from './components/layout/HostChromeContext';
// ViewMenu declaration types (re-exported from shared for app convenience).
export type { ViewMenu, ViewMenuEntry } from './types/viewMenu';

// =============================================================================
// AUTH
// =============================================================================

// Hook for reading the authenticated user identity
export { useAuthUser, useLogout } from './hooks/useAuthUser';
export type { AuthUser } from './hooks/useAuthUser';

// Hook for reading subscription state from the authenticated identity
export { useSubscriptions } from './hooks/useSubscriptions';

// =============================================================================
// VIEWS — shell-owned overlays
// =============================================================================

export { default as AccountProvider } from './providers/AccountProvider';
export { default as SettingsProvider } from './providers/SettingsProvider';

// Hook for plugin views to subscribe to shell lifecycle events (iframe protocol)
export { useIframeBridge } from './hooks/useIframeBridge';

// TypeScript message type definitions for the iframe protocol
export type { ShellToIframeMsg, IframeToShellMsg, ShellInitMsg } from './util/iframeBridgeProtocol';

// =============================================================================
// COMPONENT LIBRARY — opt-in document management
// =============================================================================

// Documents — VS Code document model (instantiable class)
export { Documents } from './components/docs/Documents';
export type { Document, Editor, EditorGroup, SplitOrientation, DocumentsState, WorkspaceBinding } from './components/docs/Documents';
export type { LayoutNode, LayoutLeaf, LayoutSplit } from './components/docs/Documents';
// Re-export IVirtualFileSystem from shared-ui for convenience
export type { IVirtualFileSystem } from 'shared/modules/explorer/types';

// DocTabs — tab bar UI component per EditorGroup
export { default as DocTabs } from './components/docs/DocTabs';
export type { DocTabsProps } from './components/docs/DocTabs';

// DocSplitLayout — recursive split layout renderer using allotment
export { default as DocSplitLayout } from './components/docs/DocSplitLayout';
export type { DocSplitLayoutProps } from './components/docs/DocSplitLayout';

// DocExplorer — generic file tree panel (re-export of shared-ui Explorer)
export { DocExplorer } from './components/docs/DocExplorer';
export type { DocExplorerProps, DocExplorerConfig, DocEntry, DocEntryChild, DocEntryStatus } from './components/docs/DocExplorer';

// Cross-app component loader
export { useAppComponent } from './hooks/useAppComponent';

// =============================================================================
// ICONS
// =============================================================================


// =============================================================================
// CURATED API SURFACE — versioned contract entry (see api.ts)
// =============================================================================

// One typed object bundling every shell-provided symbol apps consume. Frozen by
// `./builder shell:freeze` into packages/shell/contract.
// The ENTIRE curated surface — the runtime module MUST match the frozen
// contract exactly (api.ts is the single curation point; this star keeps
// the live barrel and the contract from ever diverging).
export * from './api';
export { getShellApi } from './api';
export type { ShellApiShape } from './api';
// The contract version — its own file so freeze can auto-write it (not part of
// the frozen surface).
export { SHELL_API_VERSION } from './apiver';
