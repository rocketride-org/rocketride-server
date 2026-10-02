# Building Shell Apps in the Monorepo

First-party shell apps built inside this monorepo's workspace, alongside
`packages/shell` and `apps/shared`.

The app API — `AppManifest`, `AppDescriptor`, shell props, screen zones, hooks,
`connectionManager`, the documents system, the virtual file system,
`DocExplorer`/`DocTabs`, cross-app component loading, and theming — is the same
in both setups and is documented once, publicly, at
[Shell API](https://docs.rocketride.org/guides/apps)
(source: `docs/public/product/guides/apps/index.md`). Only the project setup differs,
and that difference is what this page covers.

## Standalone vs monorepo

| | Standalone | Monorepo |
|---|---|---|
| **Import types from** | `rocketride/app-sdk` | `shell` (surface) + `rocketride` (SDK) |
| **Install** | `npm install rocketride` | workspace link (`shell` override) + `rocketride: workspace:*` |
| **MF shared** | `rocketride/app-sdk` | `shell` + `rocketride` |
| **Build** | `npx rsbuild build` | `./builder my-app:build` |
| **Deploy** | Deploy from the App Builder; the server builds from source | Builder copies to server static; the engine seeds it as a version |

Monorepo apps import types from `shell` rather than `rocketride/app-sdk`; the
type names, hooks, and functions are identical.

## What the server serves

A browser never loads an app from the folder a build writes to. Outside a
dev-server preview, it loads app code from one place only: a versioned URL,
`/apps/<appId>/v<N>/remoteEntry.js`, whose files the engine reads from its own
store. If a rebuild does not show up in the browser, check this chain before
debugging your code.

`./builder my-app:build` moves a monorepo app's bundle through three places:

1. `rsbuild build` writes it to `build/apps/<appId>/`.
2. The copy step syncs that folder to `dist/server/static/apps/<appId>/`, next
   to the engine binary.
3. When the engine starts, it seeds every app listed in `apps.json` into its
   store as a version, copying the files from `static/apps/<appId>/`. It does
   this when the app has no version yet, or when the `version` in the app's
   `package.json` differs from the one it seeded last. An app with no
   `version` in its `package.json` is never re-seeded. (RocketRide Cloud runs
   the same seeding from its deploy tooling instead of at startup.)

What follows from that:

- **A rebuild alone changes nothing a browser sees.** The engine keeps serving
  the version it already seeded. To pick up a rebuild, change `version` in the
  app's `package.json`, rebuild, and restart the engine.
- **`<appId>` is `appManifest.id`, not the folder name.** An app in
  `apps/my-app` with the id `rocketride.myApp` builds to
  `build/apps/rocketride.myApp/`. The seeding step looks the bundle up by id,
  so a folder named after anything else is never found and the app does not
  load. The id is required: when it is missing, the builder's shared app
  module (`scripts/lib/appModule.js`) falls back to the folder name for its
  own paths only and prints a `Warning: ... has no appManifest.id` line. That
  fallback does not give you a working app, so add the id when you see the
  warning.
- **`static/apps/<appId>/` is not where the shell loads app code from.** The
  shell only requests bundles from the versioned URL. Direct requests to that
  folder are meant for assets such as the icon and readme.
- **A standalone app's `dist/` is never served.** Its preview loads from the
  App Builder's dev server, and its users load a version the server built from
  the deployed source. See "Build Configuration" in
  `docs/agents/context/ROCKETRIDE_APPS.md`.

---

## Building the app

### 1. Create the app package

```text
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

### 2. package.json

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
    "@module-federation/rsbuild-plugin": "^2.5.1",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "rocketride": "workspace:*",
    "shell": "file:../../.rocketride/shell/shell.tgz"
  },
  "devDependencies": {
    "@rsbuild/core": "~2.0.11",
    "@rsbuild/plugin-react": "~2.0.1",
    "typescript": "^5.3.0"
  }
}
```

The `shell` spec stays in the portable `file:` form so the app can be lifted
into its own repo unchanged; inside the monorepo, the workspace root's
`overrides: { shell: 'workspace:*' }` resolves it to the in-tree platform
package instead — a plain link, so fresh clones and CI install without any
prebuilt artifact. `rocketride` is the SDK door: import protocol classes,
enums, constants, and API types from it. Client *instances* still come only
from `useShellConnection()` — the shell owns the connection.

`rsbuild.config.ts` imports `@rsbuild/core` and `@rsbuild/plugin-react` directly,
so both have to be declared here — pnpm's isolated `node_modules` will not resolve
them from another workspace package. Match the versions the existing apps pin
(`apps/hello-ui/package.json` is the reference); a different major of
`@rsbuild/core` will not share a Module Federation runtime with the shell.

### 3. AppDescriptor: import from `shell`

```typescript
import type { AppDescriptor } from 'shell';
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

### 4. App and Sidebar: same as standalone

```typescript
// MyApp.tsx — import from 'shell' instead of 'rocketride/app-sdk'
import type { ShellAppProps } from 'shell';
```

### 5. Add to workspace and build

```yaml
# pnpm-workspace.yaml
packages:
  - 'apps/my-app'
```

```bash
pnpm install
./builder my-app:build
```

### Builder tasks (`scripts/tasks.js`)

```javascript
const path = require('path');
const { execCommand, syncDir, formatSyncStats, removeDir, BUILD_ROOT, DIST_ROOT } = require('../../../scripts/lib');
const { registerApp } = require('../../../scripts/lib/registerApp');

const APP_ROOT = path.join(__dirname, '..');
// Both folders are keyed on appManifest.id, not the folder name.
const APP_ID = require('../package.json').appManifest.id;
const BUILD_DIR = path.join(BUILD_ROOT, 'apps', APP_ID);
const SERVER_STATIC_DIR = path.join(DIST_ROOT, 'server', 'static', 'apps', APP_ID);

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

### rsbuild.config.ts

This consumes `shell` and `rocketride` as host-provided MF singletons
(`import: false` — nothing bundled; the `shared` library is static and needs no
share entry):

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
// The app id keys the build output dir and the served static dir, so fail the
// build when it is missing instead of building under a wrong name.
const appId = pkg.appManifest?.id;
if (typeof appId !== 'string' || appId.length === 0) {
  throw new Error('package.json must define a non-empty appManifest.id');
}
const moduleId = appId.replace(/[^a-zA-Z0-9_$]/g, '_');

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
        // import: false — the host always provides these at runtime, so no
        // fallback copy is bundled into the remote.
        'shell':      { singleton: true, requiredVersion: false, import: false },
        'rocketride': { singleton: true, requiredVersion: false, import: false },
      },
    }),
  ],
  server: { port: 3014 },
  source: { entry: { index: './src/index.ts' } },
  output: {
    // Keyed on appManifest.id so it matches the folder the copy step reads.
    distPath: { root: `../../build/apps/${appId}` },
    assetPrefix: 'auto',
    cleanDistPath: true,
    sourceMap: { js: 'source-map', css: true },
  },
}));
```
