---
title: Shell Apps API Reference
sidebar_label: Reference
---

# Shell Apps: Complete API Surface

Everything below is exported from `'rocketride/app-sdk'`. The
[Shell Apps guide](/guides/apps) covers how these fit together.

### Types

`ShellAppProps`, `ShellSidebarProps`, `WorkspacePrefs`, `WorkspaceState`, `AppWorkspaceState`, `AppManifestEntry`, `AppDescriptor`, `AppSettingDefinition`, `ShellConfig`, `ShellBrandingConfig`, `ShellThemeConfig`, `ShellThemeOption`, `ShellAccountConfig`, `ShellApiConfig`, `ShellEventMap`, `DebugLogEntry`, `WorkspaceAction`, `IWorkspaceContext`, `AuthUser`, `Document`, `Editor`, `EditorGroup`, `SplitOrientation`, `DocumentsState`, `IVirtualFileSystem`, `DocExplorerProps`, `DocExplorerConfig`, `DocEntry`, `DocEntryChild`, `DocEntryStatus`, `DocTabsProps`, `UseAppComponentResult`, `ShellToIframeMsg`, `IframeToShellMsg`, `ShellInitMsg`, `InitClientOptions`, `ShellProps`, `SidebarProps`

### Hooks

`useShellConnection()`, `useShellApiConfig()`, `useWorkspace()`, `useAuthUser()`, `useLogout()`, `useSubscriptions()`, `useAppComponent()`, `useShellEvents()`, `useShellEvent()`, `useClient()`, `useConnectionStatus()`, `usePolling()`, `useClickOutside()`, `useFixedPopupPosition()`

### Functions

`connectionManager.emit()`, `connectionManager.on()`, `connectionManager.getClient()`, `connectionManager.isConnected()`, `getDebugLog()`, `clearDebugLog()`, `onAny()`, `getClient()`

### Classes

`Documents`: instantiable document model with methods: `openDocument()`, `openStaticDocument()`, `createDocument()`, `closeEditor()`, `updateContent()`, `saveDocument()`, `revertDocument()`, `splitGroup()`, `splitGroupWithDocument()`, `moveEditor()`, `closeGroup()`, `updateSplitSizes()`, `setActiveEditor()`, `setActiveGroup()`, `updateEditorViewport()`, `updateEditorViewState()`, `getState()`, `getDocument()`, `useStore()`, `destroy()`

### Components

`Shell`, `Sidebar`, `NavButton`, `BottomPanel`, `ConfirmDialog`, `DebugPanel`, `PopupRow`, `AccountPage`, `BillingPage`, `SettingsPage`, `DocExplorer`, `DocTabs`, `DocSplitLayout`
