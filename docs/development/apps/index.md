# Building Shell Apps in the Monorepo

First-party shell apps built inside the `saas` workspace, alongside `shell`
and `shared`.

The app API — `AppManifest`, `AppDescriptor`, shell props, screen zones, hooks,
`connectionManager`, the documents system, the virtual file system,
`DocExplorer`/`DocTabs`, cross-app component loading, and theming — is the same
in both setups and is documented once, publicly, at
[Shell Apps](https://docs.rocketride.org/develop/apps)
(source: `docs/public/product/develop/apps.md`). Only the project setup differs,
and that difference is what this page covers.

## Standalone vs monorepo

| | Standalone | Monorepo |
|---|---|---|
| **Import types from** | `rocketride/app-sdk` | `shell` (surface) + `rocketride` (SDK) |
| **Install** | `npm install rocketride` | workspace link (`shell` override) + `rocketride: workspace:*` |
| **MF shared** | `rocketride/app-sdk` | `shell` + `rocketride` |
| **Build** | `npx rsbuild build` | `./builder my-app:build` |
| **Deploy** | Upload `dist/` to CDN | Builder copies to server static |

Monorepo apps import types from `shell` rather than `rocketride/app-sdk`; the
type names, hooks, and functions are identical.

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
    distPath: { root: '../../build/apps/my-app' },
    assetPrefix: 'auto',
    cleanDistPath: true,
    sourceMap: { js: 'source-map', css: true },
  },
}));
```
