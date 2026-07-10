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
// shell-ui — public API
// =============================================================================

// =============================================================================
// TYPES
// =============================================================================

// Shell component prop contracts — used by apps implementing App/Sidebar
export type {
	ShellAppProps,
	ShellSidebarProps,
} from './workspace/types';

// Workspace and shell configuration types
export type {
	WorkspacePrefs,
	WorkspaceState,
	AppWorkspaceState,
	AppManifestEntry,
	AppDescriptor,
	AppSettingDefinition,
	ShellConfig,
	ShellBrandingConfig,
	ShellThemeConfig,
	ShellThemeOption,
	ShellAccountConfig,
	ShellApiConfig,
} from './workspace/types';

// Event bus type map — ShellEventMap re-exported from the shared contract
export type { ShellConnectionEventMap as ShellEventMap } from 'shared';
export type { DebugLogEntry } from './connection/connection';

// Connection manager class (singleton via getInstance())
export { ConnectionManager } from './connection/connection';
export type { InitOptions } from './connection/connection';

// Auth providers
export { CloudAuthProvider } from './auth/CloudAuthProvider';
export { ApiKeyAuthProvider } from './auth/ApiKeyAuthProvider';

// Connection state types (re-exported from shared for convenience)
export { ConnectionState } from 'shared';
export type { ConnectionStatus, ConnectionMode, IAuthProvider } from 'shared';

// Convenience: non-React access to the RocketRide client singleton.
// Apps should prefer ConnectionManager.getInstance().getClient() directly.
export { getClient } from './lib/getClient';

// Workspace context interface
export type { IWorkspaceContext } from './workspace/WorkspaceContext';

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

// Null-safe client access (only returns client when connected)
export { useClient } from './hooks/useClient';

// Reactive ConnectionStatus hook
export { useConnectionStatus } from './hooks/useConnectionStatus';

// =============================================================================
// WORKSPACE
// =============================================================================

// Provider that owns the workspace state tree and the hook for consuming it
export { WorkspaceProvider, useWorkspace } from './workspace/WorkspaceContext';

// =============================================================================
// LAYOUT COMPONENTS
// =============================================================================

// Top-level shell frame component
export { default as Shell } from './components/layout/Shell';
export type { ShellProps } from './components/layout/Shell';

// Collapsible panel rendered below the main content area
export { default as BottomPanel } from './components/layout/BottomPanel';

// Modal confirmation dialog
export { default as ConfirmDialog } from './components/layout/ConfirmDialog';

// Sidebar component
export { default as Sidebar } from './components/layout/Sidebar';
export type { SidebarProps } from './components/layout/Sidebar';

// Sidebar building blocks
export { NavButton } from './components/layout/Sidebar';
export { PopupRow } from 'shared/components/PopupRow';
export { useClickOutside } from 'shared/hooks/useClickOutside';
export { useFixedPopupPosition } from 'shared/hooks/useFixedPopupPosition';

// Debug panel
export { default as DebugPanel } from './components/layout/DebugPanel';

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

export { default as AccountPage } from './views/account/AccountPage';
export { default as SettingsPage } from './views/settings/SettingsPage';

// Hook for plugin views to subscribe to shell lifecycle events (iframe protocol)
export { useShellEvents } from './views/useShellEvents';

// TypeScript message type definitions for the iframe protocol
export type { ShellToIframeMsg, IframeToShellMsg, ShellInitMsg } from './views/ShellIframeProtocol';

// =============================================================================
// COMPONENT LIBRARY — opt-in document management
// =============================================================================

// Documents — VS Code document model (instantiable class)
export { Documents } from './lib/Documents';
export type { Document, Editor, EditorGroup, SplitOrientation, DocumentsState, WorkspaceBinding } from './lib/Documents';
export type { LayoutNode, LayoutLeaf, LayoutSplit } from './lib/Documents';
// Re-export IVirtualFileSystem from shared-ui for convenience
export type { IVirtualFileSystem } from 'shared/modules/explorer/types';

// DocTabs — tab bar UI component per EditorGroup
export { default as DocTabs } from './lib/DocTabs';
export type { DocTabsProps } from './lib/DocTabs';

// DocSplitLayout — recursive split layout renderer using allotment
export { default as DocSplitLayout } from './lib/DocSplitLayout';
export type { DocSplitLayoutProps } from './lib/DocSplitLayout';

// DocExplorer — generic file tree panel (re-export of shared-ui Explorer)
export { DocExplorer } from './lib/DocExplorer';
export type { DocExplorerProps, DocExplorerConfig, DocEntry, DocEntryChild, DocEntryStatus } from './lib/DocExplorer';

// Cross-app component loader
export { useAppComponent } from './lib/useAppComponent';

// =============================================================================
// ICONS
// =============================================================================

export * from './icons/BoxIcon';
