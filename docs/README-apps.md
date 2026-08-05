# Building Shell-UI Applications

A complete guide for developers building micro-frontend applications for the RocketRide Cloud platform.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Getting Started](#getting-started)
   - [Standalone App (npm install)](#standalone-app-external-repo)
   - [Monorepo App (saas workspace)](#monorepo-app-saas-workspace)
3. [The App Manifest](#the-app-manifest)
4. [The App Descriptor](#the-app-descriptor)
5. [Shell Props: What Your App Receives](#shell-props-what-your-app-receives)
6. [Screen Zones](#screen-zones)
7. [Shell Hooks & APIs](#shell-hooks--apis)
8. [The Connection Manager (connectionManager)](#the-connection-manager-connectionmanager)
9. [The Documents System](#the-documents-system)
10. [The Virtual File System (IVirtualFileSystem)](#the-virtual-file-system-ivirtualfilesystem)
11. [DocExplorer: File Tree Component](#docexplorer-file-tree-component)
12. [DocTabs: Tab Bar Component](#doctabs-tab-bar-component)
13. [Cross-App Component Loading](#cross-app-component-loading)
14. [Theming](#theming)
15. [Build Configuration](#build-configuration)
16. [Reference: Complete API Surface](#reference-complete-api-surface)

---

## Architecture Overview

Shell-UI is a thin shell framework that hosts micro-frontend applications via [Module Federation](https://module-federation.io/). The shell owns:

- **Four screen zones**: Sidebar, Client Area, Debug Panel (ALT+D), Status Bar
- **Authentication**: OAuth2 PKCE via Zitadel
- **Subscription gating**: Checks server-side subscription state before loading paid apps
- **WebSocket connection**: RocketRide client singleton
- **Workspace persistence**: Per-app state in `.workspace/` JSON files
- **Theme management**: CSS custom properties (`--rr-*`)
- **Event bus**: Typed message bus for cross-component communication

Apps are independent packages that export an `AppDescriptor` via Module Federation. The shell loads them lazily when the user activates the app.

```
┌──────────┬─────────────────────────┬────────────┐
│          │                         │            │
│ Sidebar  │      Client Area        │   Debug    │
│          │                         │  (ALT+D)   │
│          │                         │            │
├──────────┴─────────────────────────┴────────────┤
│ ● Connected    Ready                            │
└─────────────────────────────────────────────────┘
```

The shell mounts two components from your app:
- `components.App` → Client Area (required)
- `components.Sidebar` → Sidebar zone (optional; sidebar hidden if absent)

---

## Getting Started

There are two ways to build a shell-ui app:

1. **Standalone**: your own repo, `npm install rocketride`, deploy to any shell-ui host
2. **Monorepo**: inside the `saas` workspace, using `shell-ui` and `shared` directly

Both produce the same output: a Module Federation remote with an `AppDescriptor` export. The app code is identical, only the project setup differs.

---

### Standalone App (External Repo)

For external developers building apps in their own repository.

#### 1. Create a new project

```bash
mkdir my-app && cd my-app
npm init -y
npm install rocketride react react-dom
npm install -D @rsbuild/core @rsbuild/plugin-react @module-federation/rsbuild-plugin typescript
```

#### 2. Project structure

```
my-app/
├── package.json
├── rsbuild.config.ts
├── tsconfig.json
└── src/
    ├── index.ts           # MF async boundary
    ├── AppDescriptor.ts   # What the shell loads
    ├── MyApp.tsx           # Client area component
    └── MySidebar.tsx       # Sidebar component (optional)
```

#### 3. Define the manifest in `package.json`

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "appManifest": {
    "id": "mycompany.myApp",
    "publisher": "My Company",
    "name": "My App",
    "description": "A short description for the app store",
    "categories": ["tools"]
  },
  "dependencies": {
    "rocketride": "^1.0.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  }
}
```

#### 4. Create the AppDescriptor (`src/AppDescriptor.ts`)

Import types from `rocketride/app-sdk`:

```typescript
import type { AppDescriptor } from 'rocketride/app-sdk';
import MyApp from './MyApp';
import MySidebar from './MySidebar';

const MY_APP: AppDescriptor = {
  id: 'mycompany.myApp',
  name: 'My App',
  branding: { appName: 'My App' },
  components: {
    App: MyApp,
    Sidebar: MySidebar,  // omit for full-screen (no sidebar)
  },
};

export default MY_APP;
```

#### 5. Create the App component (`src/MyApp.tsx`)

```typescript
import React from 'react';
import type { ShellAppProps } from 'rocketride/app-sdk';

const MyApp: React.FC<ShellAppProps> = ({ isConnected, identity }) => {
  return (
    <div style={{ padding: 40, fontFamily: 'var(--rr-font-family)' }}>
      <h1>Hello from My App!</h1>
      <p>Connected: {isConnected ? 'Yes' : 'No'}</p>
      <p>User: {identity?.displayName ?? 'Not logged in'}</p>
    </div>
  );
};

export default MyApp;
```

#### 6. Create the Sidebar component (`src/MySidebar.tsx`)

```typescript
import React from 'react';
import type { ShellSidebarProps } from 'rocketride/app-sdk';

const MySidebar: React.FC<ShellSidebarProps> = ({ collapsed }) => {
  if (collapsed) return null;
  return (
    <div style={{ padding: 12, fontSize: 12, color: 'var(--rr-text-secondary)' }}>
      My sidebar content
    </div>
  );
};

export default MySidebar;
```

#### 7. Async boundary (`src/index.ts`)

```typescript
import('./AppDescriptor');
```

#### 8. rsbuild.config.ts

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
const moduleId = (pkg.appManifest?.id ?? 'unknown').replace(/[^a-zA-Z0-9_$]/g, '_');

export default defineConfig(() => ({
  plugins: [
    pluginReact(),
    pluginModuleFederation({
      name: moduleId,
      filename: 'remoteEntry.js',
      exposes: { './AppDescriptor': './src/AppDescriptor.ts' },
      dts: false,
      shared: {
        react:              { singleton: true, eager: true, requiredVersion: '^18.2.0' },
        'react-dom':        { singleton: true, eager: true, requiredVersion: '^18.2.0' },
        'rocketride/app-sdk': { singleton: true, requiredVersion: false },
      },
    }),
  ],
  source: { entry: { index: './src/index.ts' } },
  output: {
    distPath: { root: './dist' },
    assetPrefix: 'auto',
  },
}));
```

#### 9. Build and deploy

```bash
npx rsbuild build
```

Deploy the contents of `./dist/` to your hosting provider. The shell loads your app's `remoteEntry.js` at runtime when it appears in the app manifest.

#### Key differences from monorepo

| | Standalone | Monorepo |
|---|---|---|
| **Import types from** | `rocketride/app-sdk` | `shell-ui` |
| **Install** | `npm install rocketride` | `shell-ui: workspace:~` |
| **MF shared** | `rocketride/app-sdk` | `shell-ui` + `shared` |
| **Build** | `npx rsbuild build` | `./builder my-app:build` |
| **Deploy** | Upload `dist/` to CDN | Builder copies to server static |

---

### Monorepo App (saas Workspace)

For first-party apps built inside the `saas` monorepo.

#### 1. Create the app package

```
apps/my-app/
├── package.json
├── rsbuild.config.ts
├── tsconfig.json
├── scripts/tasks.js
└── src/
    ├── index.ts
    ├── AppDescriptor.ts
    ├── MyApp.tsx
    └── MySidebar.tsx
```

#### 2. package.json

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "private": true,
  "appManifest": {
    "id": "rocketride.myApp",
    "publisher": "Aparavi Software AG",
    "name": "My App",
    "description": "A short description for the app store",
    "categories": ["tools"]
  },
  "dependencies": {
    "@module-federation/rsbuild-plugin": "^0.9.0",
    "shell-ui": "workspace:~",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "shared": "workspace:~"
  }
}
```

#### 3. AppDescriptor: import from `shell-ui`

```typescript
import type { AppDescriptor } from 'shell-ui';
import MyApp from './MyApp';
import MySidebar from './MySidebar';

const MY_APP: AppDescriptor = {
  id: 'rocketride.myApp',
  name: 'My App',
  branding: { appName: 'My App' },
  components: {
    App: MyApp,
    Sidebar: MySidebar,
  },
};

export default MY_APP;
```

#### 4. App and Sidebar: same as standalone

```typescript
// MyApp.tsx — import from 'shell-ui' instead of 'rocketride/app-sdk'
import type { ShellAppProps } from 'shell-ui';
```

#### 5. Add to workspace and build

```yaml
# pnpm-workspace.yaml
packages:
  - 'apps/my-app'
```

```bash
pnpm install
./builder my-app:build
```

#### Monorepo-only: Builder tasks (`scripts/tasks.js`)

```javascript
const path = require('path');
const { execCommand, syncDir, formatSyncStats, removeDir, BUILD_ROOT, DIST_ROOT } = require('../../../rocketride-server/scripts/lib');
const { registerApp } = require('../../../scripts/lib/registerApp');

const APP_ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(BUILD_ROOT, 'apps', 'my-app');
const SERVER_STATIC_DIR = path.join(DIST_ROOT, 'server', 'static', 'apps', 'my-app');

module.exports = {
  name: 'my-app',
  description: 'My Application',
  actions: [
    { name: 'my-app:bundle',   action: () => ({ run: async (ctx, task) => { await execCommand('npx', ['rsbuild', 'build'], { task, cwd: APP_ROOT }); } }) },
    { name: 'my-app:register', action: () => registerApp(APP_ROOT) },
    { name: 'my-app:copy',     action: () => ({ run: async (ctx, task) => { const stats = await syncDir(BUILD_DIR, SERVER_STATIC_DIR); task.output = formatSyncStats(stats); } }) },
    {
      name: 'my-app:build',
      action: () => ({
        description: 'Build production bundle',
        steps: ['client-typescript:build', 'my-app:bundle', 'my-app:register', 'my-app:copy'],
      }),
    },
  ],
};
```

#### Monorepo-only: rsbuild.config.ts

The monorepo version adds `shared` to the MF config and uses path aliases:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
const moduleId = (pkg.appManifest?.id ?? 'unknown').replace(/[^a-zA-Z0-9_$]/g, '_');

export default defineConfig(() => ({
  plugins: [
    pluginReact(),
    pluginModuleFederation({
      name: moduleId,
      filename: 'remoteEntry.js',
      exposes: { './AppDescriptor': './src/AppDescriptor.ts' },
      dts: false,
      shared: {
        react:       { singleton: true, eager: true, requiredVersion: '^18.2.0' },
        'react-dom': { singleton: true, eager: true, requiredVersion: '^18.2.0' },
        'shell-ui':  { singleton: true, requiredVersion: false },
        'shared':    { singleton: true, requiredVersion: false },
      },
    }),
  ],
  resolve: {
    alias: {
      shared: path.resolve(__dirname, '../../rocketride-server/packages/shared-ui/src'),
      'shell-ui': path.resolve(__dirname, '../../rocketride-server/apps/shell-ui/src/index.ts'),
    },
  },
  server: { port: 3014 },
  source: { entry: { index: './src/index.ts' } },
  output: {
    distPath: { root: '../../build/apps/my-app' },
    assetPrefix: 'auto',
    cleanDistPath: true,
    sourceMap: { js: 'source-map', css: true },
  },
}));
```

---

## The App Manifest

Declared in `package.json` under the `appManifest` key. This metadata is available at boot without loading the app bundle, used for the app store, authentication gating, and settings.

```typescript
interface AppManifest {
  /** Stable unique identifier (e.g. 'rocketride.myApp'). */
  id: string;
  /** Publisher name shown in the app store (e.g. 'My Company'). */
  publisher?: string;
  /** Display name shown in the app switcher. */
  name: string;
  /** Short description for the app store. */
  description?: string;
  /** Path to icon file (e.g. './src/icon.svg'). */
  icon?: string;
  /** Markdown readme for the app detail page. */
  readme?: string;
  /** Categories for filtering (e.g. ['tools', 'ai']). */
  categories?: string[];
  /** When false, the app runs without authentication. Default: true. */
  authenticated?: boolean;
  /** When false, the shell header (app name/icon in the sidebar) is hidden. Default: true. */
  showHeader?: boolean;
  /** When false, the status bar is hidden for this app. Default: true. */
  showStatusBar?: boolean;
  /** Settings the app requires. Shown in the shell's Settings overlay. */
  settings?: AppSettingDefinition[];
  /** Internal: MF module identifier (derived from id). */
  moduleId?: string;
  /** App lifecycle status (e.g. 'auth', 'free', 'unsubscribed', 'subscribed', 'trialing', 'past_due', 'canceled'). */
  appStatus?: string;
  /** Whether the app is available on the desktop (non-cloud) platform. */
  onDesktop?: boolean;
}
```

### Settings

Apps can declare runtime settings (API keys, config values) that the shell manages:

```json
{
  "appManifest": {
    "settings": [
      {
        "key": "MY_API_KEY",
        "label": "API Key",
        "description": "Your API key for the external service",
        "required": true
      }
    ]
  }
}
```

Settings are:
- Rendered in the shell's Settings overlay (grouped by app)
- Persisted to `.workspace/settings.json`
- Available to your app via `useShellApiConfig()`, access as `config.MY_API_KEY`

---

## The App Descriptor

The runtime descriptor your app exports. Loaded lazily when the user first activates your app.

```typescript
interface AppDescriptor {
  id: string;                              // Must match manifest id
  name: string;                            // Display name
  icon?: React.ReactNode;                  // Icon in app switcher
  branding: ShellBrandingConfig;           // Sidebar header branding

  components: {
    App: React.ComponentType<ShellAppProps>;          // Required — client area
    Sidebar?: React.ComponentType<ShellSidebarProps>; // Optional — sidebar zone
    [key: string]: React.ComponentType<any>;          // Additional — for cross-app loading
  };
}
```

The `components` object serves double duty:
- **`App`** and **`Sidebar`** are well-known names the shell mounts in its screen zones
- **Any other keys** (e.g. `Canvas`, `Toolbar`, `DataGrid`) are ignored by the shell but accessible to other apps via `loadedApps` in the workspace context

### ShellBrandingConfig

```typescript
interface ShellBrandingConfig {
  appName: string;                 // Sidebar header text
  logo?: React.ReactNode;          // Expanded sidebar logo
  logoCollapsed?: React.ReactNode; // Collapsed sidebar logo
  iconDark?: React.ReactNode;      // Icon for dark palette (light-colored)
  iconLight?: React.ReactNode;     // Icon for light palette (dark-colored)
  icon?: React.ReactNode;          // Generic fallback icon
  welcomeLogo?: React.ReactNode;   // Welcome/loading screen logo
  welcomeTitle?: string;           // Welcome screen title
  welcomeSubtitle?: string;        // Welcome screen subtitle
}
```

**Icon resolution order**: the shell picks the best icon for the sidebar header:
1. `iconDark` / `iconLight` (matched to the active palette mode)
2. `icon` (generic branding icon)
3. Manifest `icon` URL (from `package.json`)
4. 2-letter monogram fallback

Pre-built theme-aware SVGs are available in `shared-ui/assets/rocketride/`:
- `rocketride-dark.svg`: light body (`#E0DDF0`) for dark backgrounds
- `rocketride-light.svg`: dark body (`#1E1A34`) for light backgrounds
- `rocketride.svg`: `currentColor` body, CSS-controlled

---

## Shell Props: What Your App Receives

### ShellAppProps (your App component)

```typescript
interface ShellAppProps {
  /** Whether the RocketRide WebSocket is currently connected. */
  isConnected: boolean;
  /** Authenticated user identity, or null when not logged in. */
  identity: ConnectResult | null;
}
```

### ShellSidebarProps (your Sidebar component)

```typescript
interface ShellSidebarProps {
  /** True when the sidebar is in collapsed (icon-only) mode. */
  collapsed: boolean;
}
```

When `collapsed` is true, hide your sidebar content or show only icons.

---

## Screen Zones

| Zone | Owner | Content |
|------|-------|---------|
| **Sidebar** | Shell frame + your `Sidebar` component | App switcher header, your sidebar content, theme/account/settings footer |
| **Client Area** | Your `App` component | Whatever your app renders |
| **Debug Panel** | Shell (ALT+D toggle) | Live event log, postMessage traffic |
| **Status Bar** | Shell | Connection status, app name, ready state |
| **Overlays** | Shell | Account, Billing, Settings (triggered from sidebar footer) |

If your app omits `components.Sidebar`, the sidebar zone is hidden entirely, your app gets the full window width.

---

## Shell Hooks & APIs

Import everything from `'shell-ui'`:

```typescript
import { useShellConnection, useShellApiConfig, useWorkspace, connectionManager } from 'shell-ui';
```

### Connection

| Hook/Function | Returns | Purpose |
|---------------|---------|---------|
| `useShellConnection()` | `{ client, isConnected, statusMessage }` | Access the RocketRide WebSocket client |
| `useShellApiConfig()` | `ShellApiConfig` | Read runtime config (API URLs, keys, user settings) |
| `getClient()` | `RocketRideClient \| null` | Non-React access to the client singleton |

### Auth

| Hook | Returns | Purpose |
|------|---------|---------|
| `useAuthUser()` | `ConnectResult \| null` | Current authenticated user identity |
| `useLogout()` | `() => void` | Trigger logout |
| `useSubscriptions()` | `{ subscribedAppIds, subscriptionStatuses }` | User's active subscriptions |

### Workspace

| Hook | Returns | Purpose |
|------|---------|---------|
| `useWorkspace()` | `IWorkspaceContext` | Access workspace state and dispatch |

The workspace context provides:
- `seeded`: True once pre-auth default state has been populated (before connection)
- `loaded`: True once persisted workspace state has been read from disk (after connection)
- `prefs`: Current app preferences (theme, active view, etc.)
- `appState`: Opaque per-app state (used by Documents)
- `settings`: User-configured settings
- `activeAppId`: Current app ID
- `appManifest`: All registered apps
- `appLoading`: Whether the active app is currently loading
- `loadedApps`: Map of already-loaded app descriptors (for cross-app component loading)
- `loadApp(appId)`: Trigger lazy loading of an app's descriptor
- `updateAppState(patch)`: Update per-app state
- `updateSetting(key, value)`: Update a single setting
- `updatePrefs(patch)`: Update workspace preferences
- `themeOptions`: Available theme choices
- `setTheme(themeId)`: Switch the active theme
- `dispatch(action)`: Update prefs or switch apps
- `emit(event, payload)` / `on(event, handler)`: Event bus (delegates to connectionManager)

### Workspace Lifecycle: `seeded` vs `loaded`

The workspace has a two-phase startup:

1. **Seeded** (`seeded = true`, `loaded = false`): The workspace has been populated with hardcoded defaults (default prefs, empty appState, empty settings). This happens immediately, before authentication or WebSocket connection. The Shell renders at this point so unauthenticated apps (e.g. home/landing page) can display.

2. **Loaded** (`seeded = true`, `loaded = true`): The WebSocket is connected and persisted state has been read from disk (`.workspace/global.json`, per-app workspace files, `settings.json`). Persisted prefs, appState, and settings overwrite the seeded defaults. Debounced persistence (auto-save) only activates after this point.

**What this means for your app:**

- The **Shell** renders as soon as `seeded` is true. It is then up to each app to decide whether it needs to wait for `loaded`.
- **Unauthenticated apps** (`authenticated: false`) can render immediately on seeded state, they receive `isConnected=false` and `identity=null` and should be designed to work with those values.
- **Authenticated apps** that depend on persisted settings (API keys, saved state) should gate on `loaded` before rendering data-dependent UI:

```typescript
const { loaded, settings } = useWorkspace();

if (!loaded) return <div>Loading workspace…</div>;

// Safe to read persisted settings here
const apiKey = settings.MY_API_KEY;
```

- **Persistence is safe**: debounced saves to disk only fire when `loaded` is true, so seeded defaults are never accidentally written over persisted data.

---

## The Connection Manager (connectionManager)

A typed, module-level event bus singleton. Works from React components, hooks, plain functions, anywhere.

### Basic usage

```typescript
import { connectionManager } from 'shell-ui';

// Emit an event
connectionManager.emit('shell:loginRequest', { appId: 'rocketride.myApp' });

// Subscribe to an event (returns unsubscribe function)
const unsub = connectionManager.on('shell:connected', () => {
  console.log('Connected!');
});

// Later: unsubscribe
unsub();
```

### In a React component

```typescript
useEffect(() => {
  const unsub = connectionManager.on('shell:event', ({ event }) => {
    console.log('Server event:', event);
  });
  return unsub; // cleanup on unmount
}, []);
```

### Defined events

| Event | Payload | Direction | Description |
|-------|---------|-----------|-------------|
| `shell:connected` | `{}` | Shell → Apps | WebSocket connection established |
| `shell:disconnected` | `{ reason: string; hasError: boolean }` | Shell → Apps | WebSocket connection lost |
| `shell:login` | `{ user: ConnectResult }` | Shell → Apps | User authenticated |
| `shell:logout` | `{}` | Shell → Apps | User logged out |
| `shell:loginRequest` | `{ appId?: string }` | Apps → Shell | Request OAuth login (optionally targeting an app) |
| `shell:logoutRequest` | `{}` | Apps → Shell | Request logout |
| `shell:switchApp` | `{ appId: string }` | Apps → Shell | Switch the active app |
| `shell:subscribe` | `{ app: AppManifestEntry, plan?: CheckoutPlan }` | Apps → Shell | Open subscription checkout for an app; optional `plan` preselects a tier and skips the picker (straight to payment) |
| `shell:myApps` | `{}` | Apps → Shell | Navigate to My Apps |
| `shell:accountUpdate` | `ConnectResult` | Server → Shell | Server-pushed account/subscription change |
| `shell:servicesUpdated` | `{ services: Record<string, unknown>; servicesError?: string }` | Shell → Apps | Service catalog fetch completed |
| `shell:sidebarCollapsing` | `{}` | Shell → Apps | Sidebar is collapsing (for layout adjustments) |
| `shell:themeChange` | `{ tokens: Record<string, string> }` | Shell → Apps | Theme CSS tokens changed |
| `shell:statusMessage` | `{ message: string \| null }` | Shell → Apps | Transient status bar text changed |
| `shell:statusChange` | `{ connected: boolean; ... }` | Shell → Apps | Full connection state machine update |
| `shell:error` | `{ error: Error \| unknown }` | Shell → Apps | Connection or operation error |
| `shell:event` | `{ event: unknown }` | Server → Apps | Raw server event forwarded from WebSocket |

### Extending the event map

Add custom events via TypeScript module augmentation:

```typescript
declare module 'shell-ui' {
  interface ShellEventMap {
    'myapp:dataUpdated': { recordId: string; timestamp: number };
    'myapp:exportComplete': { fileUrl: string };
  }
}

// Now type-safe:
connectionManager.emit('myapp:dataUpdated', { recordId: '123', timestamp: Date.now() });
```

### Debug logging

All events are automatically captured in a circular buffer (500 entries) visible in the Debug Panel (ALT+D).

```typescript
import { getDebugLog, clearDebugLog, onAny } from 'shell-ui';

// Get all captured events
const log = getDebugLog(); // DebugLogEntry[]

// Listen to ALL events (for custom logging)
const unsub = onAny((event, payload) => {
  console.log(`[${event}]`, payload);
});
```

---

## The Documents System

A VS Code-style document model for apps that manage files/documents. **Completely opt-in**, simple apps don't need it.

`Documents` is an **instantiable class**: your app creates it, owns it, passes it where needed. The shell never sees it.

### Core concepts

| Concept | Description |
|---------|-------------|
| **Document** | One per URI. Holds content in memory. Tracks dirty state and version. |
| **Editor** | A view onto a Document. Independent viewport state (scroll, cursor). Multiple editors can view the same document. |
| **EditorGroup** | A pane container. Holds an ordered list of editors. Supports horizontal/vertical splits. |

### Creating an instance

Create a `Documents` instance in your App component, passing an `IVirtualFileSystem`:

```typescript
// src/docs.ts — shared instance for your app
import { Documents } from 'shell-ui';  // or 'rocketride/app-sdk'
import type { IVirtualFileSystem } from 'shell-ui';

let _docs: Documents | null = null;

export function getDocs(): Documents {
  if (!_docs) throw new Error('Documents not initialised');
  return _docs;
}

export function createDocs(vfs: IVirtualFileSystem): Documents {
  _docs = new Documents(vfs);
  return _docs;
}

export function destroyDocs(): void {
  _docs?.destroy();
  _docs = null;
}
```

```typescript
// src/MyApp.tsx
import { createDocs, destroyDocs } from './docs';

const MyApp: React.FC<ShellAppProps> = () => {
  const { client } = useShellConnection();

  useEffect(() => {
    const vfs: IVirtualFileSystem = {
      list:   (dir) => client.fsListDir(dir),
      read:   (path) => client.fsReadJson(path),
      write:  (path, content) => client.fsWriteJson(path, content),
      rename: (old, new_) => client.fsRename(old, new_),
      delete: (path) => client.fsDelete(path),
      mkdir:  (path) => client.fsMkdir(path),
    };
    createDocs(vfs);
    return () => destroyDocs();
  }, [client]);

  return <MyAppInner />;
};
```

### Using the instance (call methods from anywhere)

```typescript
import { getDocs } from './docs';

// Open a file
await getDocs().openDocument('path/to/file.txt');

// Create a new document with initial content
const uri = getDocs().createDocument(undefined, { key: 'value' });

// Update content (any serializable value — stored as-is)
getDocs().updateContent(uri, { key: 'updated' });

// Save to disk
await getDocs().saveDocument(uri);
```

All operations are methods on the `Documents` instance:

| Method | Description |
|--------|-------------|
| `openDocument(uri, groupId?)` | Open a file (reads from VFS if not already open) |
| `createDocument(groupId?, content?)` | Create a new untitled document |
| `closeEditor(editorId)` | Close an editor (disposes doc if last clean ref) |
| `updateContent(uri, content)` | Update in-memory content (marks dirty) |
| `saveDocument(uri)` | Write to disk via VFS (marks clean) |
| `revertDocument(uri)` | Re-read from disk (replaces content) |
| `splitGroup(groupId, orientation)` | Split an editor group |
| `moveEditor(editorId, targetGroupId)` | Move editor between groups |
| `closeGroup(groupId)` | Close all editors in a group |
| `setActiveEditor(groupId, index)` | Activate an editor within a group |
| `setActiveGroup(groupId)` | Focus a group |
| `openStaticDocument(uri, label, content?, groupId?)` | Open a read-only static document with a display label |
| `splitGroupWithDocument(groupId, orientation)` | Split a group, moving the active document to the new pane |
| `updateSplitSizes(splitNodeId, sizes)` | Update the sizes of a split layout node |
| `updateEditorViewState(editorId, viewState)` | Persist an editor's view state (e.g. scroll, cursor) |
| `getState()` | Read state without subscribing |
| `getDocument(uri)` | Get a single document by URI |
| `destroy()` | Clean up the instance |

### React subscription

```typescript
import { getDocs } from './docs';

const MyComponent: React.FC = () => {
  const state = getDocs().useStore(); // re-renders on any state change

  const activeGroup = state.groups[state.activeGroupId];
  const activeEditorId = activeGroup?.editorIds[activeGroup.activeEditorIndex];
  const activeEditor = activeEditorId ? state.editors[activeEditorId] : undefined;
  const activeDoc = activeEditor ? state.documents[activeEditor.documentUri] : undefined;

  return <div>{activeDoc?.uri ?? 'No document open'}</div>;
};
```

### Sharing between App and Sidebar

Your `App` and `Sidebar` components are React siblings, they can't share a React context. Instead, they share the same `Documents` instance via the module-level `getDocs()` function:

```
MyApp (creates instance)     MySidebar (uses same instance)
     ↓                            ↓
  createDocs(vfs)              getDocs()
     ↓                            ↓
  getDocs().useStore()         getDocs().openDocument(path)
```

### Content type

`Document.content` is `unknown`, the exact object you store is the exact object you get back. No serialization happens inside the Documents class. The VFS handles serialization at the disk boundary.

- Pipeline editor: stores a `PipelineConfig` object
- Text editor: stores a `string`
- Image editor: stores a base64 string or metadata object

---

## The Virtual File System (IVirtualFileSystem)

The single abstraction for all file I/O. Created by the app, passed to both `new Documents(vfs)` and `DocExplorer`.

```typescript
interface IVirtualFileSystem {
  list(dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]>;
  read(path: string): Promise<unknown>;
  write(path: string, content: unknown): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  delete(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}
```

### Example: RocketRide client VFS

```typescript
const vfs: IVirtualFileSystem = {
  list: async (dir) => {
    const result = await client.fsListDir(`projects/${dir}`);
    return result.entries.map(e => ({ name: e.name, type: e.type }));
  },
  read:   (path) => client.fsReadJson(`projects/${path}`),
  write:  (path, content) => client.fsWriteJson(`projects/${path}`, content),
  rename: (old, new_) => client.fsRename(`projects/${old}`, `projects/${new_}`),
  delete: (path) => client.fsDelete(`projects/${path}`),
  mkdir:  (path) => client.fsMkdir(`projects/${path}`),
};
```

### Example: REST API VFS

```typescript
const vfs: IVirtualFileSystem = {
  list: async (dir) => {
    const res = await fetch(`/api/files?dir=${dir}`);
    return res.json();
  },
  read: async (path) => {
    const res = await fetch(`/api/files/${path}`);
    return res.json();
  },
  write: async (path, content) => {
    await fetch(`/api/files/${path}`, { method: 'PUT', body: JSON.stringify(content) });
  },
  rename: async (old, new_) => {
    await fetch(`/api/files/${old}/rename`, { method: 'POST', body: JSON.stringify({ to: new_ }) });
  },
  delete: async (path) => {
    await fetch(`/api/files/${path}`, { method: 'DELETE' });
  },
  mkdir: async (path) => {
    await fetch(`/api/files/${path}`, { method: 'POST', body: JSON.stringify({ type: 'dir' }) });
  },
};
```

---

## DocExplorer: File Tree Component

A generic file tree panel (like VS Code's EXPLORER). Renders a hierarchical file tree with:

- Directory expand/collapse
- Tree/flat view toggle
- File selection and active highlight
- Inline rename and create
- Context menus (rename/delete)
- Status dots (running/error/warning)
- Optional child items under files (with action buttons)
- Keyboard navigation

```typescript
import { DocExplorer } from 'shell-ui';
import type { DocExplorerConfig, DocEntry, IVirtualFileSystem } from 'shell-ui';

const config: DocExplorerConfig = {
  title: 'My Files',
  extensions: ['.txt', '.md'],
  displayName: (name) => name.replace(/\.(txt|md)$/, ''),
  emptyMessage: 'No files yet',
  createPlaceholder: 'file name',
};

<DocExplorer
  vfs={myVfs}
  config={config}
  entries={entries}
  statuses={statusMap}
  isConnected={isConnected}
  activeFilePath={activeUri}
  onOpenFile={(path) => getDocs().openDocument(path)}
  onFileManage={(action, path, newName) => { /* rename/delete/create */ }}
  onRefresh={() => refreshFileList()}
/>
```

### DocExplorerConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `title` | `string` | (required) | Section header (e.g. "Pipelines", "Photos") |
| `extensions` | `string[] \| null` | `null` | File extensions to filter. Null = show all. |
| `displayName` | `(filename: string) => string` | Strips known extensions | Custom display name formatter |
| `createPlaceholder` | `string` | `'file name'` | Placeholder for inline create input |
| `emptyMessage` | `string` | `'No files'` | Empty state message |

---

## DocTabs: Tab Bar Component

A tab bar UI for a single editor group. Takes a `Documents` instance as a prop.

```typescript
import { DocTabs } from 'shell-ui';
import { getDocs } from './docs';

<DocTabs
  docs={getDocs()}
  groupId={groupId}
  onDirtyClose={(editorId, uri) => {
    // Show "save changes?" dialog
  }}
/>
```

Features:
- Tab per editor in the group
- Dirty indicator (dot)
- Close button (on hover)
- Active tab highlight
- Calls `docs.setActiveEditor()` / `docs.closeEditor()` on the provided instance

---

## Cross-App Component Loading

Apps can expose components for other apps to use, and load components from other apps at runtime via Module Federation.

### Exposing components

Add them to your `components` object in the AppDescriptor. They're bundled automatically because they're imported, no extra `exposes` in rsbuild needed.

```typescript
const MY_APP: AppDescriptor = {
  id: 'rocketride.myApp',
  name: 'My App',
  branding: { appName: 'My App' },
  components: {
    App: MyApp,
    Sidebar: MySidebar,
    // Additional components — shell ignores these, but other apps can access them
    SpecialChart: MySpecialChartComponent,
    DataGrid: MyDataGridComponent,
  },
};
```

Your `rsbuild.config.ts` still only needs one expose:

```typescript
exposes: {
  './AppDescriptor': './src/AppDescriptor.ts',
}
```

When the shell loads your AppDescriptor, all components referenced in `components` are included in the bundle automatically.

### Loading components from another app

Use `useAppComponent()`, it lazy-loads the target app's descriptor if needed and returns the component once available:

```typescript
import { useAppComponent } from 'shell-ui';  // or 'rocketride/app-sdk'

const MyComponent: React.FC = () => {
  const Chart = useAppComponent('rocketride.otherApp', 'SpecialChart');

  if (!Chart) return <div>Loading...</div>;
  return <Chart data={myData} />;
};
```

The hook:
- Returns `null` while the target app's descriptor is loading
- Triggers a lazy load automatically if the app hasn't been visited yet
- Returns the component once available, no manual loading needed

---

## Theming

The shell manages themes via CSS custom properties. Your app should use `--rr-*` variables for all colors, fonts, and borders.

### Available CSS variables

| Variable | Purpose |
|----------|---------|
| `--rr-bg-default` | Main background |
| `--rr-bg-paper` | Card/panel background |
| `--rr-bg-surface-alt` | Hover/alternate background |
| `--rr-bg-input` | Input field background |
| `--rr-text-primary` | Primary text |
| `--rr-text-secondary` | Secondary/muted text |
| `--rr-text-disabled` | Disabled text |
| `--rr-brand` | Brand/accent color |
| `--rr-border` | Border color |
| `--rr-font-family` | Primary font |
| `--rr-font-family-mono` | Monospace font |
| `--rr-color-success` | Success green |
| `--rr-color-warning` | Warning orange |
| `--rr-color-error` | Error red |

### Responding to theme changes

```typescript
useEffect(() => {
  return connectionManager.on('shell:themeChange', ({ tokens }) => {
    // tokens is a Record<string, string> of all --rr-* values
    console.log('New theme:', tokens['--rr-brand']);
  });
}, []);
```

---

## Build Configuration

See the [Getting Started](#getting-started) section for complete `rsbuild.config.ts` templates for both standalone and monorepo apps.

Key points:
- The MF container `name` is derived automatically from `appManifest.id` in `package.json`
- Always expose `./AppDescriptor` as the single MF entry point
- Standalone apps share `rocketride/app-sdk`; monorepo apps share `shell-ui` + `shared`
- React and react-dom must be shared singletons to avoid duplicate instances

---

## Reference: Complete API Surface

**Monorepo apps** import from `'shell-ui'`. **Standalone apps** import from `'rocketride/app-sdk'`.
The API surface is identical: same types, same hooks, same functions.

### Types

`ShellAppProps`, `ShellSidebarProps`, `WorkspacePrefs`, `WorkspaceState`, `AppWorkspaceState`, `AppManifestEntry`, `AppDescriptor`, `AppSettingDefinition`, `ShellConfig`, `ShellBrandingConfig`, `ShellThemeConfig`, `ShellThemeOption`, `ShellAccountConfig`, `ShellApiConfig`, `ShellEventMap`, `DebugLogEntry`, `WorkspaceAction`, `IWorkspaceContext`, `AuthUser`, `Document`, `Editor`, `EditorGroup`, `SplitOrientation`, `DocumentsState`, `IVirtualFileSystem`, `DocExplorerProps`, `DocExplorerConfig`, `DocEntry`, `DocEntryChild`, `DocEntryStatus`, `DocTabsProps`, `UseAppComponentResult`, `ShellToIframeMsg`, `IframeToShellMsg`, `ShellInitMsg`, `InitClientOptions`, `ShellProps`, `SidebarProps`

### Hooks

`useShellConnection()`, `useShellApiConfig()`, `useWorkspace()`, `useAuthUser()`, `useLogout()`, `useSubscriptions()`, `useAppComponent()`, `useShellEvents()`, `useShellEvent()`, `useClient()`, `useConnectionStatus()`, `usePolling()`, `useClickOutside()`, `useFixedPopupPosition()`

### Functions

`connectionManager.emit()`, `connectionManager.on()`, `connectionManager.getClient()`, `connectionManager.isConnected()`, `getDebugLog()`, `clearDebugLog()`, `onAny()`, `getClient()`

### Classes

`Documents`: instantiable document model with methods: `openDocument()`, `createDocument()`, `closeEditor()`, `updateContent()`, `saveDocument()`, `revertDocument()`, `splitGroup()`, `moveEditor()`, `closeGroup()`, `setActiveEditor()`, `setActiveGroup()`, `updateEditorViewport()`, `getState()`, `getDocument()`, `useStore()`, `destroy()`

### Components

`Shell`, `Sidebar`, `NavButton`, `BottomPanel`, `ConfirmDialog`, `DebugPanel`, `PopupRow`, `AccountPage`, `BillingPage`, `SettingsPage`, `DocExplorer`, `DocTabs`, `DocSplitLayout`
