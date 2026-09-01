---
title: Shell Apps API Reference
sidebar_label: Reference
---

# Shell Apps: Complete API Surface

Everything below is exported from `'rocketride/app-sdk'`. The
[Shell Apps guide](/guides/apps) covers how these fit together.

### Types

`ShellAppProps`, `ConnectResult`, `AppDescriptor`, `AppManifestEntry`, `SettingValue`, `SettingSchema`, `AppConfiguration`, `ShellBrandingConfig`, `WorkspacePrefs`, `IWorkspaceContext`, `ShellApiConfig`, `ShellThemeConfig`, `ShellThemeOption`, `IVirtualFileSystem`, `Document`, `Editor`, `EditorGroup`, `SplitOrientation`, `DocumentsState`, `ShellEventMap`

### Hooks

`useShellConnection()`, `useShellApiConfig()`, `useWorkspace()`, `useAuthUser()`, `useLogout()`, `useSubscriptions()`, `useAppComponent()`

### Functions

`connectionManager.emit()`, `connectionManager.on()`, `connectionManager.getClient()`, `connectionManager.isConnected()`, `getDebugLog()`, `clearDebugLog()`, `onAny()`, `getClient()`

### Classes

`Documents`: instantiable document model with methods: `openDocument()`, `createDocument()`, `closeEditor()`, `updateContent()`, `saveDocument()`, `revertDocument()`, `splitGroup()`, `moveEditor()`, `closeGroup()`, `setActiveEditor()`, `setActiveGroup()`, `updateEditorViewport()`, `getState()`, `getDocument()`, `useStore()`, `destroy()`

### Components

The app-sdk exports no components. `AppLayout`, `DocExplorer`, `DocTabs`, and `DocSplitLayout` (along with the shell frame components) are exported from the `shell` package.
