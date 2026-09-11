# Building RocketRide Apps

The complete guide to building apps for the RocketRide platform in your own
workspace, using the App Builder.

A RocketRide app is a React micro-frontend that the platform shell loads at
runtime. You build it in a folder under `./apps` in your workspace, watch it
live in the App Builder's preview, then deploy versions to the server and
publish them to yourself, your team, or the public store.

**Vocabulary used throughout (these are not interchangeable):**

- **deploy** — ship a snapshot of your app's source to the server, where it
  is built and becomes the next immutable registry version.
- **publish** — bind an already-deployed version to an audience rung
  (`@me`, `@team/<name>`, `@public`). Publishing moves a pointer; it never
  rebuilds anything.
- **UI component** — a React component (yours, or a stock one from
  `shell`); **pipeline component** — a processing node inside a RocketRide
  pipeline (`ROCKETRIDE_COMPONENT_REFERENCE.md`). This guide always
  qualifies which kind is meant.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [The App Builder](#the-app-builder)
3. [Creating an App: the Scaffold](#creating-an-app-the-scaffold)
4. [The Dev Loop](#the-dev-loop)
5. [The App Manifest](#the-app-manifest)
6. [The App Descriptor](#the-app-descriptor)
7. [AppLayout and Screen Zones](#applayout-and-screen-zones)
8. [Shell Props: What Your App Receives](#shell-props-what-your-app-receives)
9. [Shell Hooks & APIs](#shell-hooks--apis)
10. [The Connection Manager](#the-connection-manager)
11. [State & Persistence](#state--persistence)
12. [Embedding Pipelines](#embedding-pipelines)
13. [The Documents System](#the-documents-system)
14. [The Virtual File System (IVirtualFileSystem)](#the-virtual-file-system-ivirtualfilesystem)
15. [DocExplorer: File Tree Component](#docexplorer-file-tree-component)
16. [DocTabs and DocSplitLayout](#doctabs-and-docsplitlayout)
17. [Cross-App Component Loading](#cross-app-component-loading)
18. [Theming](#theming)
19. [Styles Doctrine](#styles-doctrine)
20. [Build Configuration](#build-configuration)
21. [Deploy and Publish](#deploy-and-publish)
22. [Reference: Complete API Surface](#reference-complete-api-surface)

---

## Architecture Overview

The RocketRide shell is a thin host that loads apps via
[Module Federation](https://module-federation.io/). The shell owns the
frame (app switcher, sidebar chrome, status bar, ALT+D debug panel, and the
account/settings/billing overlays), authentication (OAuth2 — your app never
handles credentials), the shared WebSocket client, workspace persistence
(`.workspace/`), theme management (`--rr-*` CSS custom properties), and the
typed platform event bus (`shell:*`).

Your app is an independent package that exposes one module — an
`AppDescriptor` — through Module Federation. The shell loads it lazily when
the user activates the app, mounts the descriptor's `app` component in the
client area, and your app declares its own layout (sidebar, status bar) from
inside its one React tree with `<AppLayout>`.

```text
┌──────────┬─────────────────────────┬────────────┐
│          │                         │            │
│ Sidebar  │      Client Area        │   Debug    │
│ (yours,  │      (your app)         │  (ALT+D)   │
│ optional)│                         │            │
├──────────┴─────────────────────────┴────────────┤
│ ● Connected    Ready                            │
└─────────────────────────────────────────────────┘
```

Three packages make up your world:

| Import from | What it is |
|---|---|
| `'shell'` | The platform surface: hooks, stock UI components, layout, documents, icons, types. Host-provided at runtime, never bundled. |
| `'rocketride'` | The client SDK: protocol types, enums, constants. The client *instance* always comes from `useShellConnection()`. |
| `'react'` / `'react-dom'` | Shared singletons with the host. |

Your app's `package.json` carries a
`"shell": "file:../../.rocketride/shell/shell.tgz"` dependency — a vendored
copy of the shell's types that the App Builder places in
`.rocketride/shell/` and keeps in sync with the connected server. The
tarball bundles the SDK's types too, so `import type { ... } from
'rocketride'` type-checks with no extra install. At runtime both modules
resolve to the host's live singletons through Module Federation — nothing
platform-side is ever compiled into your bundle. (The SDK also publishes
the same app surface as the `rocketride/app-sdk` subpath for apps built
outside a RocketRide workspace; inside one, import from `'shell'`.)

---

## The App Builder

The App Builder is where you develop, package, and ship an app. Open it by
opening your app's `.rrapp` file — a contentless trigger; everything about
the app (id, name) lives in `package.json`'s `appManifest` block. The
screen is one tab strip with five activity views, the app's `id · version`
in the trailing corner:

| Tab | Question it answers |
|---|---|
| **Dashboard** | What state is my app in, and what should I do next? |
| **Design** | Does it look and behave right? (live preview + feeds) |
| **Package** | Is my app complete and buildable? (identity, assets, includes) |
| **Store** | Is my public listing ready? (commerce only) |
| **Deploy** | Which versions exist, and who serves which one? |

### Dashboard

The landing tab. A lead card narrates the app's state in plain sentences —
the latest version, its review state, what serves where — and recommends the
next step with an "Open ..." button. Below it, the **review conversation**:
the app's entire deployment history as one chronological stream, where
system events (deploy, publish, submission, verdict) render as timeline
items and reviewer/developer messages render as chat bubbles. The reply box
posts into the same thread the store reviewer reads — you can message the
review team at any time, before or during a review.

### Design

One workspace with pill-switched panes: **Preview | Code | Components |
Events | Console | Errors**. Switching a pane never resets the session — the
dev server, watch state, and accumulated feeds persist. Details in
[The Dev Loop](#the-dev-loop).

### Package

Everything every app needs regardless of the store: display name and
description, the icon and README assets (typed or picked, with live
preview), the `include` paths that make the server build work, and a
readiness box narrating whether the app is ready to deploy and publish
personally. Edits stage into a draft with a Save/Cancel bar; storage is
your app's `package.json` `appManifest` — files are the truth.

### Store

The public-store paperwork only: billing mode, pricing plans, and the store
requirements checklist. Personal and team publishing never touches this
tab. When every requirement passes, the tab hands you to the Deploy tab —
submission itself happens there, per version.

### Deploy

The version rail and the "Where this app is live" table. Covered in full in
[Deploy and Publish](#deploy-and-publish).

### The namespace gate

Every app id is `<developerId>.<name>`. Your organization claims its
developer id once (self-service, on the Deploy tab: letters and underscores
only); from then on the org can only deploy apps inside that namespace. If
an app's id prefix does not match your org's developer id, Store and Deploy
render read-only with a banner explaining the fix (rename the id in
`package.json`). Design and Package stay fully editable — local work is
always allowed.

---

## Creating an App: the Scaffold

Two rules before anything else:

- **pnpm is required — not npm.** The entire app toolchain (the wizard's
  dependency install, the dev loop's watch reinstalls, the workspace
  linking of the vendored `shell` package) runs `pnpm`. Make sure it is
  installed and on PATH (`npm install -g pnpm` once) before creating or
  building an app; running `npm install` in an app folder is never
  correct and can corrupt the workspace layout.
- **Both platform packages are server-vendored — never registry
  versions.** The platform downloads the connected server's own `shell`
  and `rocketride` packages into `.rocketride/shell/` and
  `.rocketride/client/`, and apps pin them by `file:` spec. The npm
  registry's `rocketride` can lag the server badly; never replace either
  pin with a registry install. The server build enforces the same rule on
  its side — deployed apps are always built against the server's own
  platform artifacts, whatever the package.json said.
- **Always create new apps through the scaffold — never hand-create the
  files.** The scaffold carries load-bearing details that are easy to get
  subtly wrong by hand: the pinned Module Federation plugin version, the
  `src/index.ts` async boundary, the jsx-dev-runtime HMR anchor, the
  `*.pipe` module declaration, and the vendored platform-package pins.
  Hand-rolled app folders fail in ways whose symptoms (blank preview,
  frozen HMR, share-negotiation errors) appear far from the cause.
  Two front doors render the identical templates: the App Builder's New
  App wizard (humans), and `client.deploy.createApp` (agents and
  scripts). A `rocketride app create` CLI form also exists for CI
  pipelines — but as an agent, prefer the API for everything.

  **Agent bootstrap — the platform pre-stages everything you need.** In
  any workspace the extension has opened, `.rocketride/client/
  rocketride.tgz` and `.rocketride/shell/shell.tgz` are vendored at boot
  (server-matched when connected, packaged fallbacks offline). Install
  the client from the local tarball — never from the npm registry, which
  lags the server:

  ```bash
  # once, in a workspace with no package.json yet:
  pnpm init
  pnpm add ./.rocketride/client/rocketride.tgz
  ```

  Then everything is API:

  ```typescript
  import { RocketRideClient } from 'rocketride';

  const client = new RocketRideClient();          // reads .env
  const created = await client.deploy.createApp('reports', {
  	template: 'Blank',
  	displayName: 'Reports',
  	statusFooter: true,
  });
  // created.appId = 'local.reports', created.folder = 'apps/reports'
  ```

  The scaffold defaults the id to `local.<slug>` (pass `developerId` once
  your org's id is registered) and is scaffolding only — nothing deploys
  until the normal lifecycle (`verifyApp` → `addApp` → `publishApp`)
  runs.

The New App wizard collects an app-name slug, a display name, a template
(**Blank** or **Dashboard**), and three frame options that each toggle a
chrome region of the generated app: **sidebar** (two-column layout with a
navigation sidebar), **status footer** (`AppLayout showStatus`), and
**doc tabs** (a document tab strip: Documents + DocSplitLayout + DocTabs).

The wizard assembles the app id from your organization's developer id plus
the slug, validates it, and writes the app folder under `./apps` in your
workspace. Dependencies install automatically through one shared
`pnpm install` at the workspace root — all apps are workspace members
sharing one `node_modules`.

### The scaffolded files

| File | Why it exists |
|---|---|
| `package.json` | Identity (`appManifest`) plus toolchain pins. `build` runs `tsc --noEmit` **before** `rsbuild build` — rsbuild transpiles without type-checking, so type errors must fail the build rather than sit silent. `@module-federation/rsbuild-plugin` is pinned **exactly** (`2.5.1`): the container must run against the shell's MF runtime generation; a floating range that drifts ahead breaks share negotiation. `@types/node` is a real dependency (the rsbuild config uses `node:fs`/`node:path`). |
| `<name>.rrapp` | The trigger file that opens the App Builder. Contentless — identity lives in `package.json`. |
| `rsbuild.config.mts` | The Module Federation remote build. See [Build Configuration](#build-configuration). |
| `tsconfig.json` | Strict TypeScript. Platform types resolve from the installed `shell` package (the vendored `shell.tgz`). |
| `.gitignore` | App-level ignore (`node_modules/`, `dist/`) so the folder stays self-protecting even copied out of the workspace or git-inited on its own. The workspace root's ignore carries the full set (`.rocketride/`, `.env`, `**/node_modules/`, `**/dist/`); deploys hard-exclude all of it regardless. |
| `icon.svg` | Neutral placeholder so icon readiness starts green and store tiles never render a bare fallback glyph. Replacing it is your first branding act. |
| `README.md` | Ships with the app and appears on its store listing; readme readiness starts green. |
| `src/index.ts` | The Module Federation **async boundary** — its entire body is `import('./AppDescriptor');`. Required so shared modules are negotiated before any app code runs. |
| `src/global.d.ts` | Ambient module declaration for `*.pipe` imports (see [Embedding Pipelines](#embedding-pipelines)). |
| `src/AppDescriptor.ts` | The single exposed module. Starts with `import 'react/jsx-dev-runtime';` — the **HMR anchor**: it keeps the shared JSX runtime referenced even when your root component fails to compile. Without it, an error build orphans the runtime, hot reload tombstones its module factory, and every later fix silently fails to apply (the frozen-preview bug). Do not remove it. |
| `src/App.tsx` | Your root component: `<AppLayout>` composed from the frame options you picked, wrapping a starter `Content`. Recompose its props (`sidebar`, `showStatus`) any time. |

---

## The Dev Loop

### Watch

Opening an App Builder panel starts the watch for that app (gated by the
`rocketride.appdev.autoWatch` setting):

1. **Install** — one `pnpm install` at the workspace root, shared and
   single-flight across all apps. Editing your app's `package.json`
   triggers a reinstall and a dev-server restart automatically.
2. **Serve + rebuild** — `rsbuild dev` runs in your app folder, serving the
   remote on the app's dev port and rebuilding on every save.
3. **Register** — after each successful rebuild, your **personal dev
   overlay** on the server is re-pointed at the served bundle, so the
   preview (and only you) sees the dev version. Re-registering also keeps
   the overlay's idle TTL alive.
4. **Reload** — the preview reloads (debounced) after each successful
   rebuild; hot updates apply where possible, with fallback to a full
   preview reload.

Closing the panel stops the watch (after a short linger so a quick reopen
revives it) and unregisters the dev overlay. The watch status line reports
`idle | installing | building | ok | error`, the last build duration, and
where the dev bundle serves from — every error carries a human-readable
reason telling you what to fix.

### The Design panes

- **Preview** — the live app inside a device frame. Three layouts (desktop,
  tablet, phone), each with five common CSS viewports; the iframe gets those
  exact dimensions so responsive breakpoints fire exactly as on the device.
  Orientation, zoom, fit-to-window; all preview preferences persist per
  workspace and app.
- **Code** — file tree + editor (web App Builder only; in VS Code files are
  native and a strip links to them).
- **Components** — the stock UI component gallery: live examples of
  everything importable from `'shell'`.
- **Events** — the platform event feed (`shell:*`) as it fires.
- **Console** — your app's console output (`console.log` lands here).
- **Errors** — runtime errors with source locations.

### Preview toolbar extras

- **Inherit Auth** — hands the host's signed-in session to the preview, so
  an `authenticated` app renders with a real identity. Uncheck to make the
  preview run its own sign-in cycle (testing the logged-out experience).
- **Theme** — flip the preview between light and dark without touching
  your own shell theme.
- **Reload** — manual preview reload; **Debug** (VS Code) — F5 launches a
  real external browser against the same dev session, with full devtools.

The preview URL is a deep link into the shell — `?appid=<your.app>&rrdev=1`
on the connected server: the same shell your users see, locked to your app
with the dev overlay active.

### If the preview loops on sign-in

The preview is a real shell session, so an authentication problem looks
exactly like it would for a user: a sign-in screen that keeps coming back.
Work down this checklist:

1. **Check Inherit Auth.** Checked (the default) hands your signed-in
   session to the preview automatically — it should render authenticated
   with no prompt. Unchecked, the preview deliberately boots signed out and
   runs its own sign-in cycle; for an app with `authenticated: true` (the
   manifest default) that means a sign-in screen on every boot — the
   logged-out experience you asked to test, not a bug.
2. **Sign in explicitly if that is what you want.** The Sign In button
   inside the preview always authenticates it, even with Inherit Auth off —
   the checkbox governs *automatic* inheritance only. The sign-in runs
   through the host, so popup blocking cannot strand it.
3. **Suspect a stale host session.** The preview inherits your session
   as-is: if your own sign-in has expired, the handed-over session is dead
   and the preview bounces straight back to sign-in no matter how often it
   reboots. Sign out and back in yourself, then reload the preview.
4. **Reset in order.** Toggle Inherit Auth off and on — every flip pushes
   the definitive session state into the preview and reboots it — then
   Reload the preview (a full dev-session reset), then sign out/in in the
   host.
5. **Reconsider `authenticated`.** If the app should work signed out, set
   `authenticated: false` in the manifest; the preview then renders with
   `isConnected: false` and `identity: null` instead of demanding a
   session.

---

## The App Manifest

Declared in your app's `package.json` under the `appManifest` key. This
metadata is available to the platform without loading your bundle — it
drives the app store listing, authentication gating, packaging, and billing.
The Package and Store tabs are editors over this block; you can also edit it
by hand.

### Complete field reference

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `string` | required | Stable unique identity, `<developerId>.<name>` (e.g. `acme.brandy`). The prefix must be your org's claimed namespace to deploy or publish. Renaming the id makes it a different app. |
| `projectId` | `string` | auto | Working-copy GUID the App Builder manages — tells one checkout apart from another; rides deploys only as provenance. Leave it alone. |
| `publisher` | `string` | — | Publisher display name in the app store. |
| `name` | `string` | required | Display name (app switcher, store tile). |
| `description` | `string` | — | Short description for the store listing. |
| `icon` | `string` | — | App-folder-relative icon path (e.g. `./icon.svg`); must live inside the app folder. |
| `readme` | `string` | — | App-folder-relative store README (markdown); must live inside the app folder. |
| `categories` | `string[]` | `[]` | Store filter categories (e.g. `["tools"]`). |
| `mode` | `string` | `'free'` | Billing mode: `'free'`, `'subscription'`, or `'paywall'`. |
| `authenticated` | `boolean` | `true` | `false` lets the app run signed-out (`isConnected: false`, `identity: null`). |
| `showStatusBar` | `boolean` | `true` | `false` hides the shell status bar for this app. |
| `shells` | `string[]` | all | Compatible shells: any of `'saas'`, `'oss'`, `'vscode'`. Omitted = all. |
| `include` | `string[]` | — | Extra workspace-relative paths packed into the deploy zip — see [below](#packaging-extra-directories-include). |
| `typecheck` | `boolean` | `true` | `false` = the server build skips the `tsc` gate and deploys even with type errors — a visible waiver, not a default. |
| `billing.plans` | `object[]` | — | Pricing plans for paid modes: `{ nickname, amountCents, currency, interval, metadata? }` (Stripe-shaped). A *proposal* that rides every deploy and goes live when a version is approved for the store. Edited on the Store tab. |
| `contributes.configuration` | `object` | — | Settings declaration in the VS Code `contributes.configuration` shape (below). |

The id grammar is enforced at scaffold and at deploy:
`^[a-z][a-z_]*\.[a-z][a-zA-Z0-9_-]*$` — publisher segment first, then a dot,
then the app name (`acme.s3-explorer`, `acme.app2`).

### Declaring settings (`contributes.configuration`)

Apps declare user-editable settings exactly like a VS Code extension does —
if you have written one, you already know the shape:

```json
{
  "appManifest": {
    "contributes": {
      "configuration": {
        "title": "Brand Studio",
        "properties": {
          "acme.brandy.maxResults": {
            "type": "integer",
            "default": 50,
            "description": "Maximum results per query."
          }
        }
      }
    }
  }
}
```

Rules and behavior:

- Every key must be prefixed with your app id (`acme.brandy.<setting>`).
- `type` is one of `string | number | integer | boolean`; `enum`,
  `enumDescriptions`, `markdownDescription`, `order`, `required`, and
  `placeholder` refine the control. The display label derives from the
  key, VS Code style (`maxResults` renders as "Max Results") — there is
  no label field.
- Settings render in the shell's Settings overlay, grouped by `title`;
  only user *overrides* are stored (defaults live in your schema).
- Read settings via `useWorkspace().settings` — an *effective* map with
  defaults already merged, keyed by the full dotted key:

```typescript
const { settings } = useWorkspace();
const maxResults = settings['acme.brandy.maxResults'] as number;
```

### Packaging extra directories (`include`)

Deploying an app uploads its SOURCE — the server owns the build. The deploy
zip mirrors your workspace tree: the app folder packs at its
workspace-relative position, and any `include` entries pack verbatim at
theirs, so relative references between them (a shared-source tsconfig
mapping, a `file:` dependency) resolve identically after the server unpacks:

```json
{
  "appManifest": {
    "include": ["libs/ui-kit"]
  }
}
```

Entries are workspace-relative paths (files or directories) — no absolute
paths, drive letters, or `.`/`..` segments, and every entry must exist or
the deploy fails. Packing honors your workspace's `.gitignore` plus a
built-in baseline (`node_modules/`, `dist/`, `.git/`): dependency trees and
build output never ship — the server installs and builds from source. The
zipped upload caps at 50 MB; hitting it usually means an over-broad
`include` entry.

---

## The App Descriptor

The runtime object your app exposes — the one Module Federation module the
shell loads when the user activates your app.

```typescript
// src/AppDescriptor.ts
import 'react/jsx-dev-runtime';   // HMR anchor — keep this line (see Scaffold)

import type { AppDescriptor } from 'shell';
import App from './App';

const descriptor: AppDescriptor = {
	id: 'acme.brandy',                       // must match appManifest.id
	name: 'Brand Studio',
	branding: { appName: 'Brand Studio' },
	app: App,                                // the ONE mount point
};

export default descriptor;
```

The full shape:

```typescript
interface AppDescriptor {
	id: string;                     // matches the manifest id
	name: string;                   // display name in the app switcher
	icon?: React.ReactNode;         // optional switcher icon
	branding: ShellBrandingConfig;  // logo + welcome-screen tokens
	/** The app's ONE mount point, rendered raw in the client area. The app
	 * composes its own layout inside with <AppLayout>. */
	app: React.ComponentType<ShellAppProps>;
	/** Optional cross-app component catalog. Never mounted by the shell —
	 * entries are loadable by other apps via useAppComponent(). */
	components?: { [key: string]: React.ComponentType<any> | undefined };
}
```

Note what is **not** here: there is no separate `Sidebar` mount. Your app is
one React tree; the sidebar and status bar are declared as `<AppLayout>`
props from inside it, so state, module singletons, and callbacks are shared
naturally between sidebar and client area. The `components` map exists only
for [cross-app loading](#cross-app-component-loading).

### ShellBrandingConfig

```typescript
interface ShellBrandingConfig {
	appName: string;                 // Sidebar header text
	logo?: React.ReactNode;          // Expanded sidebar logo
	logoCollapsed?: React.ReactNode; // Collapsed sidebar logo
	iconDark?: React.ReactNode;      // Icon for dark palettes (light-colored)
	iconLight?: React.ReactNode;     // Icon for light palettes (dark-colored)
	icon?: React.ReactNode;          // Generic fallback icon
	welcomeLogo?: React.ReactNode;   // Welcome/loading screen logo
	welcomeTitle?: string;
	welcomeSubtitle?: string;
}
```

Sidebar-header icon resolution order: `iconDark`/`iconLight` (matched to
the active palette), then `icon`, then the manifest `icon` file, then a
2-letter monogram fallback.

---

## AppLayout and Screen Zones

`AppLayout` is the one app-root layout component. Render it as the root of
your `app` mount and declare your layout with props:

```tsx
<AppLayout>...</AppLayout>                          // one column, full client area
<AppLayout sidebar={<Nav/>}>...</AppLayout>         // two columns (sidebar + client)
<AppLayout sidebar={<Nav/>} showStatus>...</AppLayout>  // + status bar
```

```typescript
interface AppLayoutProps {
	sidebar?: ReactNode;    // present = two-column app; absent = one column
	showStatus?: boolean;   // show the status bar (default false)
	status?: ReactNode;     // status-bar middle slot; implies showStatus
	children: ReactNode;    // the client-area content
}
```

The `sidebar` node is the *scrolling portion* of the sidebar column — the
fixed chrome around it (app-switcher header, account/connection footer) is
the platform's guaranteed navigation, always rendered by the shell.
Likewise the status bar's connection identity is stock; your `status` node
fills its middle slot. Components inside your sidebar can call
`useSidebarCollapsed()` to render an icon-rail form when collapsed.

| Zone | Owner | Content |
|---|---|---|
| **Sidebar** | Shell chrome + your `sidebar` node | Switcher header, your navigation, account/theme footer |
| **Client Area** | Your app | Whatever you render inside `AppLayout` |
| **Status Bar** | Shell (opt-in via `showStatus`/`status`) | Connection status + your middle slot |
| **Debug Panel** | Shell (ALT+D) | Live log of every `shell:*` event |
| **Overlays** | Shell | Account, Settings, Environment (sidebar footer, or `shell:openOverlay`) |

If you omit `sidebar`, the sidebar zone is hidden entirely and your app
gets the full width.

---

## Shell Props: What Your App Receives

Your `app` component receives exactly two props:

```typescript
interface ShellAppProps {
	/** Whether the RocketRide WebSocket is currently connected. */
	isConnected: boolean;
	/** Authenticated user identity, or null when not logged in. */
	identity: ConnectResult | null;
}
```

Everything else — the client, workspace state, settings, theme — arrives
through hooks imported from `'shell'`.

---

## Shell Hooks & APIs

Import everything from `'shell'`:

```typescript
import { useShellConnection, useWorkspace, usePrefs, AppLayout, Button } from 'shell';
```

### Connection & auth

| Hook/Function | Returns |
|---|---|
| `useShellConnection()` | `{ client, isConnected, statusMessage }` — the primary hook. |
| `useClient()` | `RocketRideClient \| null`, re-rendering on connect/disconnect. |
| `useConnectionStatus()` | `ConnectionStatus` — the full state machine (state, retry attempt, progress message). |
| `useShellApiConfig()` | `ShellApiConfig` — runtime config the host booted with. |
| `getClient()` | Non-React access to the client singleton. |
| `useAuthUser()` | `ConnectResult \| null` — current identity (the `AuthUser` type). |
| `useLogout()` | Sign-out trigger. |
| `useSubscriptions()` | `{ desktopApps, isOnDesktop(id), getStatus(id) }` — desktop apps + subscription status, pushed live. |

```typescript
const { client, isConnected } = useShellConnection();
if (!client || !isConnected) return <div>Connecting...</div>;
```

The client instance is always the shell's — never construct a
`RocketRideClient` in an app.

### Workspace, prefs, events

| Hook | Purpose |
|---|---|
| `useWorkspace()` | `IWorkspaceContext`: prefs, appState, settings, app manifest, theme control — see [State & Persistence](#state--persistence). |
| `usePrefs()` | `{ getPref, setPref }` — the one-key preference accessor. |
| `useShellEvent(event, handler)` | Subscribe to a typed platform event with automatic cleanup. |
| `useAppComponent(appId, name)` | Load a UI component from another app (or `null` while loading). |

### Utilities

`usePolling(fn, options)` (visibility-aware polling),
`useDebouncedValue(value, ms)`, `useClickOutside(ref, onClose)`,
`useFixedPopupPosition(ref, isOpen, placement)`, `useAnnouncements()`, and
`useSidebarCollapsed()` (collapsed-sidebar detection for components inside
your `sidebar` node).

### Embedding external web content: useIframeBridge

For content that lives outside your React tree — a self-contained HTML
document, a report viewer, a sandboxed visualization — render an `<iframe>`
and wire it with `useIframeBridge(iframeRef)`. The hook installs the
standard shell-to-iframe postMessage bridge on one iframe element: it
bootstraps the content with the current theme, identity, and connection
state, then keeps forwarding platform events for the life of the frame.

```tsx
import { useRef } from 'react';
import { useIframeBridge } from 'shell';

function ReportFrame({ html }: { html: string }) {
	const frameRef = useRef<HTMLIFrameElement>(null);
	useIframeBridge(frameRef);
	return <iframe ref={frameRef} srcDoc={html} style={styles.frame} title='Report' />;
}
```

The bridge speaks a fixed message protocol. Shell to iframe (sent for you):

| Message | Payload | When |
|---|---|---|
| `shell:init` | `{ theme, user, isConnected, apiConfig }` | The reply to `view:ready` — the bootstrap snapshot. `theme` is the full `--rr-*` token map. |
| `shell:themeChange` | `{ tokens }` | The user switched themes — re-apply the token map. |
| `shell:connectionChange` | `{ isConnected }` | The platform WebSocket opened or closed. |
| `shell:login` / `shell:logout` | `{ user }` / — | Identity changed. |
| `shell:event` | `{ event }` | Every raw server push event, forwarded. |
| `shell:viewActivated` | `{ viewId }` | A tab became foreground — do deferred re-layout (canvas restore) here. |

Iframe to shell (handled for you):

| Message | Payload | Effect |
|---|---|---|
| `view:ready` | — | Marks the frame ready; the bridge answers with `shell:init`. Nothing is forwarded before this — early events are dropped, not queued. |
| `view:initialized` | — | The content painted its first themed frame — your cue to reveal the iframe. |
| `shell:logout` | — | Delegates to the shell's real sign-out flow. |
| `shell:openTab` | `{ viewType, label }` | Asks the shell to open a singleton tab. |

Rules that make it work:

- **Use `srcdoc` (or a same-origin URL).** The bridge posts every message
  with the shell's own origin as the target, so a document on a foreign
  origin never receives it — by design: identity and config must not leak
  to third-party pages. `srcdoc` content inherits the parent origin and
  gets the full bridge; a truly external site can still be iframed, but
  only as a plain frame with no bridge.
- **Seed the theme into the `srcdoc` markup.** Waiting for `shell:init` to
  theme the document paints one unthemed frame first. Instead, generate a
  `:root { ... }` style block from the current token map when you build the
  `srcdoc` string — the shell writes every `--rr-*` token as an inline
  style property on the document root, so the current values are trivial to
  read — and use `shell:init`/`shell:themeChange` only to keep them fresh
  afterwards.
- **Hide until ready.** Keep the iframe `visibility: 'hidden'` until the
  content posts `view:initialized`, then reveal (listen for that message on
  `window` yourself — the bridge handles only the cross-cutting messages).
  Never use `display: 'none'` for this: a display-none frame has zero
  dimensions, which breaks any layout measured inside it.

The content side needs no dependencies:

```html
<script>
	function applyTokens(tokens) {
		for (const [k, v] of Object.entries(tokens || {})) {
			document.documentElement.style.setProperty(k, v);
		}
	}
	window.addEventListener('message', (e) => {
		const msg = e.data || {};
		if (msg.type === 'shell:init') {
			applyTokens(msg.theme);
			window.parent.postMessage({ type: 'view:initialized' }, '*');
		} else if (msg.type === 'shell:themeChange') {
			applyTokens(msg.tokens);
		}
	});
	window.parent.postMessage({ type: 'view:ready' }, '*');
</script>
```

Style the embedded document with `var(--rr-*)` exactly as you would in the
app itself and it follows every theme switch live.

---

## The Connection Manager

The typed platform event bus and connection owner. It is a singleton class —
get the instance, never construct it:

```typescript
import { ConnectionManager } from 'shell';

const cm = ConnectionManager.getInstance();
cm.emit('shell:switchApp', { appId: 'acme.brandy' });
const unsub = cm.on('shell:connected', () => console.log('Connected'));
unsub();
```

In React, prefer the hook — it unsubscribes on unmount and always calls
your latest handler:

```typescript
useShellEvent('shell:event', ({ event }) => {
	console.log('Server pushed:', event);
});
```

### Platform events

All events and payloads are defined in `ShellEventMap` (importable as a type
from `'shell'`). The full set:

| Event | Payload | Meaning |
|---|---|---|
| `shell:connected` | `{}` | WebSocket handshake + auth completed. |
| `shell:disconnected` | `{ reason, hasError }` | Connection lost or closed. |
| `shell:statusMessage` | `{ message \| null }` | Transient status bar text. |
| `shell:statusChange` | `ConnectionStatus` | Full connection state machine update. |
| `shell:error` | `{ error }` | A connection attempt or operation failed. |
| `shell:event` | `{ event: DAPMessage }` | Every raw server push event, forwarded. |
| `shell:accountUpdate` | `ConnectResult` | Server-pushed account change. |
| `shell:orgChanged` | `{ orgId }` | Default organization changed (the shell reloads). |
| `shell:servicesUpdated` | `{ services, icons?, servicesError? }` | Pipeline-component service catalog (re)fetched. |
| `shell:appsUpdated` | `{ apps }` | App catalog changed — complete replacement set. |
| `shell:login` | `{ user: ConnectResult }` | Authentication succeeded. |
| `shell:logout` | `{}` | User signed out. |
| `shell:loginRequest` | `{ appId?, register? }` | UI requests sign-in. |
| `shell:logoutRequest` | `{}` | UI requests sign-out. |
| `shell:switchApp` | `{ appId }` | Switch the active app. |
| `shell:subscribe` | `{ app, plan?, promo? }` | Open subscription checkout; `plan` skips the picker. |
| `shell:unsubscribe` | `{ appId }` | Subscription cancelled — refresh entitlement views. |
| `shell:myApps` | `{}` | Navigate to the My Apps launcher. |
| `shell:openOverlay` | `{ id }` | Open a built-in overlay: `'account' \| 'settings' \| 'environment'`. |
| `shell:sidebarCollapsing` | `{}` | Sidebar is collapsing. |
| `shell:themeChange` | `{ tokens }` | Theme changed; `tokens` is the full `--rr-*` map. |
| `shell:viewActivated` | `{ viewId }` | A view/tab became active — lazy panels init here. |
| `shell:manifestRefresh` | `{ source }` | Server-side app manifest changed (dev overlay, publish, expiry). |
| `app:statusChanged` | `{ appId, version?, status, notes? }` | Store review status changed. |
| `store:changed` | `{ prefix, paths }` | Files changed under a watched store prefix. |

The event map is the platform's shared vocabulary — it carries platform
events only. For your app's internal communication, use ordinary React
state or your own emitter; do not overload the shell bus.

### Debug log

Every emitted event is captured in a circular buffer (500 entries) shown in
the Debug Panel (ALT+D) — the fastest way to see what the platform is doing
under your app. Programmatic access lives on the same singleton:

```typescript
const cm = ConnectionManager.getInstance();
const log = cm.getDebugLog();          // DebugLogEntry[]
cm.clearDebugLog();
const unsub = cm.onAny((event, payload) => console.log(event, payload));
```

---

## State & Persistence

The shell persists your app's state per user in `.workspace/` on the server:

| File | Contents |
|---|---|
| `.workspace/global.json` | Active app + globally-mirrored prefs (theme, sidebar open) |
| `.workspace/<appId>.workspace.json` | Your app's `{ prefs, appState }` |
| `.workspace/settings.json` | User setting overrides (deltas only — defaults live in your schema) |

### Prefs — small UI preferences

`prefs` is a shell-managed bag (active view, theme, sidebar state, plus any
keys you add). Two ways in:

```typescript
// The simple accessor — one key at a time
const { getPref, setPref } = usePrefs();
setPref('zoom', 1.25);

// The full context — batch updates
const { prefs, updatePrefs } = useWorkspace();
updatePrefs({ activeView: 'details' });
```

Prefs persist per user and per app, riding the workspace exactly like theme
or sidebar state — never browser `localStorage`.

### App state — your opaque blob

`appState` is entirely yours; the shell persists it but never reads it. The
update takes a functional updater:

```typescript
updateAppState((prev) => ({ ...prev, lastQuery: 'foo' }));
```

The Documents system can bind to it for automatic persistence of open
documents and layout — see [The Documents System](#the-documents-system).

### The two-phase startup: `seeded` vs `loaded`

1. **Seeded** (`seeded = true`, `loaded = false`): the workspace holds
   hardcoded defaults. Happens immediately, before authentication — the
   shell renders at this point so unauthenticated apps can display.
2. **Loaded** (`loaded = true`): the connection is up and persisted state
   has been read from `.workspace/`, overwriting the defaults.

Unauthenticated apps (`authenticated: false`) can render on seeded state —
design for `isConnected: false` and `identity: null`. Apps that depend on
persisted state should gate on `loaded`:

```typescript
const { loaded } = useWorkspace();
if (!loaded) return <div>Loading workspace...</div>;
```

Persistence is safe by construction: debounced saves (500 ms) only start
once `loaded` is true, so seeded defaults never overwrite persisted data.

### The rest of `useWorkspace()`

The context also exposes `activeAppId`, `appManifest` (all registered
apps), `loadedApps` (loaded descriptors), `loadApp(appId)`, `appLoading`,
`settings` / `settingsOverrides` / `updateSetting(key, value)`,
`themeOptions` / `setTheme(themeId)`, and `emit`/`on` (delegating to the
connection manager).

---

## Embedding Pipelines

Apps ship pipelines as data and run them through the shared client. A
pipeline file is JSON with a `.pipe` extension; the scaffold configures your
build to import it directly:

```typescript
// The rsbuild config treats .pipe as JSON, and src/global.d.ts declares the
// module type — both scaffolded for you.
import summarizer from './summarizer.pipe';
import { useShellConnection } from 'shell';

const { client } = useShellConnection();
const { token } = await client.use({ pipeline: summarizer });
```

The browser has no filesystem — always pass `pipeline:` (the imported
object), never `filepath:` (Node-only). Read
`ROCKETRIDE_PIPELINES.md` and `ROCKETRIDE_COMPONENT_REFERENCE.md`
before authoring the `.pipe` content itself, and
`ROCKETRIDE_typescript_API.md` for the full client reference.

### Secrets and configuration

Pipeline configs reference secrets as `${ROCKETRIDE_*}` placeholders.
Substitution happens server-side when you call `use()` — the values come
from the user's stored environment keys, so no secret ever ships inside
your app bundle or `.pipe` file.

### Token management

`use()` starts (or attaches to) a pipeline task and returns its `token` —
the handle for everything that follows:

```typescript
// Start once, reuse: useExisting attaches to a running instance of the
// same pipeline instead of starting a second one.
const { token } = await client.use({ pipeline, useExisting: true, ttl: 900 });

// Recover a token after a reload (project_id + source identify the task):
const existing = await client.getTaskToken({ projectId, source: 'input' });

// Pre-flight check, restart with a new config, stop:
await client.validate({ pipeline });
await client.restart({ projectId, source: 'input', pipeline });
await client.terminate(token);
```

`use()` is expensive — start the pipeline once per session and keep the
token; never start/stop around every request. `ttl` controls the idle
shutdown window (`0` = run until terminated).

### One task for everyone vs a task per user

A task's identity is owner + `project_id` + source component — and when
your app calls `use()`, the owner is the signed-in **user**. So every user
of your app gets their own instance of the pipeline, automatically.
`useExisting` does not change that: it attaches to *that user's* own
already-running instance (a reload, a second tab, a second component)
instead of failing with 'Pipeline is already running.' — it never crosses
user boundaries.

**Per-user tasks (the default, and the only behavior `use()` can produce):**

- Isolation — whatever state the pipeline holds in memory (accumulated
  documents, warm models, conversation state) belongs to that user alone.
- Cost — each user's task runs and bills under their own identity, and
  `${ROCKETRIDE_*}` placeholders resolve from *their* environment layers.
- Cleanup — each instance idles out on its own `ttl`; `terminate(token)`
  ends only that user's instance. Pass `useExisting: true` routinely so a
  reload re-attaches instead of erroring while the previous instance lives.

**One shared task for all users** is a *deployed*, team-owned pipeline, not
an app-embedded one: deploy the pipeline as its own `kind: 'pipe'` project
and point a team at it (see 'App pipes cannot be scheduled' below and the
SDK deploy docs). The team's run is a single instance; your app addresses
it by adding the `teamId` scope when resolving the token:

```typescript
const token = await client.getTaskToken({ projectId, source: 'webhook_1', teamId });
if (token) await client.send(token, data, undefined, 'text/plain');
```

- Shared state — one instance serves every caller; anything the pipeline
  accumulates is visible to all of them.
- Cost and lifecycle — the run bills to the owning team, resolves the
  team's environment, and outlives any one user's session; restarting or
  terminating it affects everyone at once.

**Choosing:** per-user when the pipeline holds per-user state or cost
should follow the user; shared when the pipeline is a service — one big
index, one warm model — whose state and cost belong to the team. When in
doubt, start per-user: it is what you get by writing nothing.

### Sending data and streaming results into your UI

- `client.send(token, data, objinfo?, mimetype?, onSSE?)` — for pipelines
  whose source pipeline component is `webhook` or `dropper`;
  `client.sendFiles(files, token)` for parallel file upload.
- `client.chat({ token, question, onSSE })` — for a `chat` source pipeline
  component.
- `onSSE: (type, data) => Promise<void>` fires for each server-sent event
  while the request is in flight (token-by-token AI output) — stream it
  straight into React state:

```typescript
const response = await client.chat({
	token,
	question,
	onSSE: async (type, data) => {
		setStreamText((prev) => prev + String(data.text ?? ''));
	},
});
```

Server push events (task status, custom pipeline-to-UI messages) arrive on
the shell bus — subscribe with `useShellEvent('shell:event', ...)`; see
`ROCKETRIDE_OBSERVABILITY.md` for the event taxonomy.

### Showing a useful error state when the pipeline fails

Failure surfaces on three levels — a robust app handles all three:

**1. The request you just made.** `send()`, `sendFiles()`, and `chat()`
throw `PipeException` (importable from `'rocketride'`) when the server
reports a pipe failure; most other calls throw errors carrying the
server's message. Catch at the call site and turn the failure into state:

```typescript
import { PipeException } from 'rocketride';

try {
	await client.chat({ token, question, onSSE });
} catch (err) {
	setError(err instanceof PipeException
		? 'The pipeline rejected the request — it may have failed mid-run.'
		: String((err as Error).message ?? err));
}
```

**2. The task itself.** `getTaskStatus(token)` is the ground truth for a
pipeline that died *between* requests: `completed` flips true once the run
is over, `exitCode !== 0` (with `exitMessage`) means it did not end well,
`errors` carries the most recent error lines (capped at 50), and
`serviceUp: false` on a pipeline that should be waiting for requests means
it cannot serve.

**3. Live signals.** Add a monitor on the token and watch the shell bus:
`apaevt_status_update` events stream the same status fields (errors and
exit code included) while the task runs, and an `apaevt_task` event with
`action: 'end'` that you did not cause — no `terminate()`, no TTL you
expected — is your cue to check the status and show the error state:

```typescript
useEffect(() => {
	if (!client || !token) return;
	client.addMonitor({ token }, ['task', 'summary']);
	return () => { client.removeMonitor({ token }, ['task', 'summary']); };
}, [client, token]);

useShellEvent('shell:event', ({ event }) => {
	const e = event as { event?: string; body?: { errors?: string[] } };
	if (e.event === 'apaevt_status_update' && e.body?.errors?.length) {
		setError(e.body.errors[e.body.errors.length - 1]);
	}
});
```

**The error UI.** Use the stock components rather than inventing one, and
keep the project identity around so recovery is one click —
`client.restart({ projectId, source, pipeline })` terminates the dead task
and starts a fresh one in a single round trip:

```tsx
if (error) {
	return (
		<EmptyState
			title='The pipeline stopped unexpectedly'
			description={error}
			action={<Button onClick={retry}>Restart pipeline</Button>}
		/>
	);
}
```

Reserve `EmptyState` for a dead pipeline that blocks the whole view. For a
degraded-but-serving pipeline (errors accumulating while requests still
succeed), render a `<Banner variant='error'>` above your content instead of
replacing it.

### App pipes cannot be scheduled

A pipeline embedded in your app exists only inside your bundle — it runs
when your code calls `use()`. Schedules (cron runs) are a feature of
pipelines *deployed to the server* as their own `kind: 'pipe'` projects via
the deploy registry. If part of your app should run on a schedule, deploy
that pipeline separately and manage it through the deploy API
(`client.deploy.*` — see the SDK docs); your app can still observe its runs
and read its outputs.

### The team-service pattern: addressing a scheduled deployment

The counterpart of embedding, and the shape "runs 9:00–18:00 for the whole
team" requirements always take: ONE shared pipeline deployed as its own
`kind: 'pipe'` project and scheduled on a team, with the app **addressing**
the running task instead of starting its own. The pieces:

- **Identity without drift** — import the `.pipe` for its `project_id` (the
  scaffold's build treats `.pipe` as JSON) and address the service as
  `{ projectId, source, teamId }`. The import is identity only — the app
  never calls `use()` on it. Listing the pipeline folder under
  `appManifest.include` packs the definition with the app as provenance.
- **Store the team NAME in settings, resolve the id at runtime** — names
  are portable across environments; a team GUID baked into a settings
  default dies on any other server. Resolve through the identity payload:

```typescript
import filePipe from '../../../pipelines/file-to-text.pipe'; // identity only
const PROJECT_ID = String(filePipe.project_id);

const teamName = String(settings['acme.droptext.teamName'] ?? 'Prod');
const team = identity?.organization?.teams.find(
	(t) => t.name.toLowerCase() === teamName.toLowerCase(),
);
const token = team
	? await client.getTaskToken({ projectId: PROJECT_ID, source: 'webhook_1', teamId: team.id })
	: null;
```

- **No token = offline, and say so** — `getTaskToken` returning nothing is
  the NORMAL state outside the service window; it is also what "the run
  ended", "nothing is deployed", and "not entitled" look like (the
  resolution carries no reason). Render an honest offline state with a
  retry action — never treat it as an error.
- **Poll; there is no push** — no event announces a scheduled run starting
  or its ttl ending. Re-check on a modest interval (30–60s) so the status
  badge flips at 09:00, and re-resolve immediately before each upload — a
  cached token can belong to a run the schedule has since ended.
- **Render service hours from the deployment, not a string literal** — when
  the signed-in user's team permissions allow it,
  `client.deploy.get(projectId, teamId)` returns the live `schedules`
  (cron + ttl); deriving the displayed window from it keeps the UI truthful
  when an operator edits the schedule. Hardcode the window only as a
  fallback.

---

## The Documents System

A VS Code-style document model for apps that manage files or documents.
**Completely opt-in** — simple apps never need it.

`Documents` is an instantiable class: your app creates it, owns it, and
passes it where needed. The shell never sees it. Three concepts: a
**Document** (one per URI; holds content in memory, tracks dirty state), an
**Editor** (a view onto a document with its own viewport state; several can
view one document), and an **EditorGroup** (a pane holding an ordered list
of editors; groups split horizontally/vertically).

### Creating an instance

```typescript
constructor(vfs?: IVirtualFileSystem | null, workspace?: WorkspaceBinding)
```

- With no arguments, documents are static/in-memory (the scaffold's
  doc-tabs frame: `new Documents()` plus `openStaticDocument`).
- Pass an [`IVirtualFileSystem`](#the-virtual-file-system-ivirtualfilesystem)
  to open, save, and revert real files.
- Pass a `WorkspaceBinding` (`{ appState, updateAppState }` from
  `useWorkspace()`) to auto-persist the layout: open documents, groups, and
  splits restore on the next visit and debounce-save on every change.

A module-level holder is the standard pattern — your components can then
reach the same instance from anywhere in the tree:

```typescript
// src/docs.ts — shared instance for your app
import { Documents } from 'shell';
import type { IVirtualFileSystem } from 'shell';

let _docs: Documents | null = null;

export function getDocs(): Documents {
	if (!_docs) throw new Error('Documents not initialised');
	return _docs;
}
export function createDocs(vfs: IVirtualFileSystem): Documents {
	return (_docs = new Documents(vfs));
}
export function destroyDocs(): void {
	_docs?.destroy();
	_docs = null;
}
```

Create it once when the client is available (e.g. in a `useEffect` keyed on
`client`), calling `createDocs(vfs)` on mount and `destroyDocs()` on
cleanup — see the next section for the `vfs` object itself.

### Method reference

| Method | Description |
|---|---|
| `openDocument(uri, groupId?)` | Open a file (reads from the VFS if not open). |
| `openStaticDocument(uri, label, content?, groupId?)` | Open a read-only static document. |
| `createDocument(groupId?, content?)` | New untitled document; returns its URI. |
| `closeEditor(editorId)` | Close an editor (disposes the doc on last clean ref). |
| `updateContent(uri, content)` | Update in-memory content (marks dirty). |
| `saveDocument(uri)` | Write to the VFS (marks clean). |
| `revertDocument(uri)` | Re-read from the VFS. |
| `splitGroup(groupId, orientation)` | Split an editor group. |
| `splitGroupWithDocument(groupId, orientation)` | Split, moving the active document over. |
| `moveEditor(editorId, targetGroupId)` | Move an editor between groups. |
| `closeGroup(groupId)` | Close all editors in a group. |
| `updateSplitSizes(splitNodeId, sizes)` | Persist a split's pane sizes. |
| `setActiveEditor(groupId, index)` / `setActiveGroup(groupId)` | Activate an editor / focus a group. |
| `updateEditorViewState(editorId, viewState)` | Persist scroll/cursor state. |
| `getState()` / `getDocument(uri)` | Read without subscribing. |
| `useStore()` | React hook — re-renders on any state change. |
| `destroy()` | Clean up the instance. |

### React subscription

```typescript
const state = getDocs().useStore();
const group = state.groups[state.activeGroupId];
const editor = state.editors[group?.editorIds[group.activeEditorIndex] ?? ''];
const doc = editor ? state.documents[editor.documentUri] : undefined;
```

### Content type

`Document.content` is `unknown` — the exact value you store is the exact
value you get back. No serialization happens inside the class; the VFS
handles it at the storage boundary.

---

## The Virtual File System (IVirtualFileSystem)

The single abstraction for file I/O, created by your app and passed to
`new Documents(vfs)`:

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

Back it with whatever storage your app uses — the RocketRide client's
account store is the common case:

```typescript
const vfs: IVirtualFileSystem = {
	list: async (dir) => {
		const result = await client.fsListDir(`projects/${dir}`);
		return result.entries.map(e => ({ name: e.name, type: e.type }));
	},
	read:   (path) => client.fsReadJson(`projects/${path}`),
	write:  (path, content) => client.fsWriteJson(`projects/${path}`, content),
	rename: (o, n) => client.fsRename(`projects/${o}`, `projects/${n}`),
	delete: (path) => client.fsDelete(`projects/${path}`),
	mkdir:  (path) => client.fsMkdir(`projects/${path}`),
};
```

A REST-backed VFS works the same way — each method wraps a fetch.
`NOOP_VFS` (from `'shell'`) is the stand-in for a required VFS prop you do
not use.

---

## DocExplorer: File Tree Component

A generic file tree panel (like VS Code's Explorer): expand/collapse,
tree/flat toggle, selection and active highlight, inline rename/create,
context menus, status dots, optional child rows with action buttons,
keyboard navigation, drag-to-move, and OS drag-in upload.

The explorer is display-only over data you provide — you pass the `entries`
and handle actions in callbacks:

```tsx
import { DocExplorer, NOOP_VFS } from 'shell';
import type { DocExplorerConfig } from 'shell';

const config: DocExplorerConfig = {
	title: 'My Files',
	extensions: ['.txt', '.md'],   // null/omitted = show all
	displayName: (name) => name.replace(/\.(txt|md)$/, ''),
	emptyMessage: 'No files yet',
};

<DocExplorer
	vfs={NOOP_VFS}                 // required by contract, unused — pass NOOP_VFS
	config={config}
	entries={entries}              // you fetch and provide the flat entry list
	statuses={statusMap}
	isConnected={isConnected}
	activeFilePath={activeUri}
	onOpenFile={(path) => getDocs().openDocument(path)}
	onFileManage={(action, path, newName) => { /* 'rename' | 'delete' | 'createFolder' | 'createFile' */ }}
	onRefresh={() => refreshFileList()}
/>
```

Omitting `onFileManage` hides the file-management UI (display-only tree);
optional `onMove` / `onUpload` callbacks enable drag-to-move and
OS-drop upload.

---

## DocTabs and DocSplitLayout

`DocTabs` renders the tab bar for one editor group; `DocSplitLayout` renders
the whole split tree, calling you back once per leaf pane:

```tsx
import { DocSplitLayout, DocTabs } from 'shell';

<DocSplitLayout
	docs={docs}
	renderPane={(groupId) => (
		<>
			<DocTabs docs={docs} groupId={groupId} isActive />
			<MyEditorFor groupId={groupId} />
		</>
	)}
/>
```

`DocTabsProps`: `docs`, `groupId`, `isActive?` (focused-group styling),
`canClose?` (whether the group itself may close), `onDirtyClose?(editorId,
uri)` (intercept closing a dirty document to show a save prompt),
`onSplit?(groupId, orientation)`, `onCloseGroup?(groupId)`.

Tabs show a dirty-indicator dot and a close button on hover, and dispatch
`setActiveEditor`/`closeEditor` on the instance you pass.

---

## Cross-App Component Loading

Apps can expose UI components for other apps, and load UI components from
other apps at runtime.

**Exposing** — add entries to the descriptor's `components` catalog; they
bundle automatically because they are imported (no extra MF configuration):

```typescript
const descriptor: AppDescriptor = {
	id: 'acme.brandy',
	name: 'Brand Studio',
	branding: { appName: 'Brand Studio' },
	app: App,
	components: { BrandChart: BrandChartComponent },  // loadable by other apps
};
```

**Loading:**

```typescript
const Chart = useAppComponent('acme.brandy', 'BrandChart');
if (!Chart) return <div>Loading...</div>;
return <Chart data={myData} />;
```

The hook returns `null` while the target app's descriptor loads (triggering
the lazy load itself if needed), then the component. Cross-app loading is
the only sanctioned dependency between apps — never import another app's
source directly.

---

## Theming

The shell manages themes via CSS custom properties. Use `--rr-*` variables
for every color, font, and border — never hardcoded values. The user's
theme choice (light, dark, and other palettes, including a Visual
Studio-flavored one) swaps the values out from under you; an app built on
tokens needs no theme-specific code.

### Core tokens

| Variable | Purpose |
|---|---|
| `--rr-bg-default` / `--rr-bg-paper` | Main / card-panel backgrounds |
| `--rr-bg-surface` / `--rr-bg-surface-alt` | Raised / alternate surfaces |
| `--rr-bg-widget` / `--rr-bg-input` | Widget-toolbar / input backgrounds |
| `--rr-bg-list-hover` / `--rr-bg-list-active` | List row hover/active |
| `--rr-text-primary` / `--rr-text-secondary` / `--rr-text-disabled` / `--rr-text-link` | Text colors |
| `--rr-brand` / `--rr-accent` / `--rr-accent-faded` | Brand and accent colors |
| `--rr-border` / `-hover` / `-focus` / `-input` | Border colors |
| `--rr-color-success` / `-warning` / `-error` / `-info` | Semantic status colors |
| `--rr-font-family`, `--rr-font-size` / `-sm` / `-xs` | Primary font and sizes |
| `--rr-icon-color` | Default icon tint |
| `--rr-chart-blue` … `--rr-chart-red` | Categorical chart palette (blue, green, yellow, purple, orange, red) |

There is no monospace token — use a fallback stack:
`fontFamily: 'var(--rr-font-mono, Consolas, monospace)'`.

The full token map type is exported as `ThemeTokens` from `'shell'`.

### Responding to theme changes

Styles built on `var(--rr-*)` update automatically. If you draw to a canvas
or otherwise need the raw values:

```typescript
useShellEvent('shell:themeChange', ({ tokens }) => {
	redraw(tokens['--rr-brand']);
});
```

Test both palettes with the Design tab's theme preview toggle before you
deploy.

---

## Styles Doctrine

The platform's UI conventions — the App Builder's Components gallery shows
all of it live.

1. **Plain CSS via style objects.** No CSS frameworks, no MUI, no
   styled-components, no separate stylesheet files. Each component file
   declares one named `styles` const at the top:

   ```typescript
   const styles: Record<string, React.CSSProperties> = {
   	wrap: { padding: 40, fontFamily: 'var(--rr-font-family, system-ui)' },
   	title: { fontSize: 22, fontWeight: 600, color: 'var(--rr-text-primary)' },
   	sub: { marginTop: 8, fontSize: 13, color: 'var(--rr-text-secondary)' },
   };
   ```

   JSX references `styles.wrap` — no inline object literals scattered
   through the markup.

2. **Tokens for every visual value.** Colors, fonts, and borders always come
   from `--rr-*` variables so all themes work for free.

3. **Stock components first.** Before building a card, badge, modal, grid,
   or input from scratch, check the surface: `Button`, `Card`, `Modal`,
   `ConfirmDialog`, `StatusBadge`, `Banner`, `InputField`, `ToggleGroup`,
   `Chip`, `DataGrid`, `TabControl`, `TabPanel`, `EmptyState`, `Section`,
   `DetailPanel`, `SidebarMenu`, `ChatView`, and more — all importable from
   `'shell'`, all token-styled and theme-correct.

4. **`commonStyles` for shared shapes.** `'shell'` exports a curated style
   vocabulary — `card`/`cardHeader`/`cardBody`, the `button*` family,
   `modal*`, `listRow`, `badge`, `tableHeader`/`tableCell`, `textMuted`,
   `fontMono`, `labelUppercase`, the `indicator*` status dots, and layout
   helpers (`columnFill`, `headerBar`, `tabContent`). Spread and extend
   (`{ ...commonStyles.buttonPrimary, minWidth: 96 }`) for genuinely
   shared shapes; keep one-off styling in your own `styles` const.

5. **No emojis** in UI text or output. Use the icon set (`Bx*` components
   from `'shell'`) for glyphs.

---

## Build Configuration

The scaffolded `rsbuild.config.mts` is the canonical build. Every setting
exists for a reason — change your ports and entries freely, but keep the
Module Federation shape intact:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';

// The MF container name derives from appManifest.id (dots → underscores).
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
			runtime: false,               // host provides the MF runtime
			shareStrategy: 'loaded-first', // use the host's loaded singletons
			shared: {
				react: { singleton: true, eager: true, requiredVersion: '^18.2.0' },
				'react-dom': { singleton: true, eager: true, requiredVersion: '^18.2.0' },
				// Platform modules arrive from the host's share scope at
				// runtime, never bundled; types come from the vendored shell.tgz.
				'shell': { singleton: true, requiredVersion: false, import: false },
				'rocketride': { singleton: true, requiredVersion: false, import: false },
			},
		}),
	],
	// .pipe files are JSON — importable and passable to client.use().
	tools: {
		rspack: {
			module: { rules: [{ test: /\.pipe$/, type: 'json' } as const] },
		},
	},
	server: { port: 3101, cors: { origin: '*' } },
	dev: { hmr: true, lazyCompilation: false, client: { protocol: 'ws', host: 'localhost', port: '<port>' } as const },
	source: { entry: { index: './src/index.ts' } },
	output: { assetPrefix: 'auto' },
}));
```

Key rules:

- **One expose.** `./AppDescriptor` is the only MF entry; everything it
  references (including the cross-app `components` catalog) bundles
  automatically.
- **The async boundary is mandatory.** `src/index.ts` must stay
  `import('./AppDescriptor');` so shared-module negotiation happens before
  any of your code runs.
- **Keep the shared block as scaffolded.** `react`/`react-dom` are eager
  singletons; `shell`/`rocketride` are host-provided (`import: false`).
  Bundling your own copy of any of them breaks the app at load time.
- **Keep the exact MF plugin pin** (`2.5.1`) — see
  [the scaffold table](#the-scaffolded-files).
- **`npm run build` = `tsc --noEmit && rsbuild build`.** Type errors fail
  the local build exactly as the server build will (unless waived with
  `typecheck: false`).

You normally never run these yourself — the watch runs the dev server, and
deploys build on the server — but they are there for CI or scripted checks.

---

## Deploy and Publish

The Deploy tab is the shipping console. Its model, in one sentence:
**deploy** creates immutable versions on the server; **publish** points
audiences at them.

### Register as a developer (once per organization)

If your org has no developer id yet, the Deploy tab shows a registration
banner. Claim a slug (letters and underscores, e.g. `acme_labs`); every app
you deploy must be named `<developerId>.<name>` — the namespace guarantee:
nobody outside your org can ever deploy into it.

### Deploy — the "+ Deploy" card

Clicking **Deploy** ("snapshot the current build to the server") asks for
an optional "what changed" comment, then packs your app's **source** into a
zip mirroring the workspace tree (app folder plus `appManifest.include`
extras, `.gitignore`-filtered, 50 MB zipped cap) and uploads it. The server
owns the build — it installs dependencies, type-checks (unless
`typecheck: false`), and builds; client-produced binaries are never
trusted. The result is the next **registry version**: an immutable integer
(`v7`), the version's wire identity forever. Your `package.json` semver
rides along as a display pill only (it may repeat across deploys; the
registry int never does).

**Replace the scaffold README before the first deploy.** The pack ships it
and the store listing renders it verbatim — boilerplate on v1 costs a
deploy + republish cycle to fix, because versions are immutable.

While the server works, the version card shows a live build ticker
(`uploaded`, `installing`, `checking`, `building`, ...). On success it
clears; on failure the card gets a **failed** badge that is a door — click
it to open the full phase-by-phase build log, failure reason at the end.

A fresh deployment is born **private**: it exists in your org's registry,
can be published internally, and is invisible to everyone else.

### Publish — "Publish to..."

Each servable version card offers **Publish to...** with one row per
audience:

| Rung | Handle | Who gets it |
|---|---|---|
| Personal | `@me` | Your own desktop — lands there automatically. |
| Team | `@team/<name>` | Members of that team. |
| Public | `@public` | The store — only versions approved by review. |

Choosing a row **is** the action: the audience's pointer moves to that
version. First publish, update, promote, and rollback are all this one
pointer move — to roll back, publish the older version to the same rung
("repoint, never rebuild"). Internal rungs serve instantly; `@public`
requires review. There is no separate org rung — "org-wide" is a team your
org admin maintains. **Remove** on a where-live row is soft: the audience
stops being served, but versions and audit history survive; publishing to
that audience again revives it.

### The review ladder (public store only)

- **Submit for review** appears on the newest servable private version
  (review always tracks your current work — to ship older code, deploy it
  again as a new version). Submitting flips the version `private → submit`.
- **Withdraw** cancels your own submission (`submit → private`).
- The verdict lands as `ready` (approved — publishable to `@public`) or
  `rejected`, pushed live to your App Builder (`app:statusChanged`), with
  reviewer notes on rejection.
- The whole exchange — submissions, verdicts, and free-form messages both
  ways — lives in the Dashboard's review conversation. You can message the
  review team there at any time, including before submitting.

### Where this app is live

The reverse index below the rail: one row per rung showing the pinned
version, its state (`enabled` / `approved` / `in review`), the audience
("on your desktop", "3 testers", "listed"), and when it was deployed there.

### Taking an app down: disable vs remove

Both verbs act on ONE audience binding — the rung's pointer — and both stop
that audience's serving immediately. Neither touches registry versions,
other rungs, or the app's history: there is no hard delete anywhere in the
deploy model.

| | **Disable** | **Remove** |
|---|---|---|
| Serving | Stops — a disabled binding never serves. | Stops. |
| Where-live listing | The row STAYS, marked disabled — a visible off switch. | The row disappears from listings. |
| Versions & history | Untouched; the action lands in the deployment history. | Untouched — soft-remove: versions and audit history survive. |
| Coming back | Publish any version to the rung — publishing always re-enables the binding. | Publish to that audience again; the binding revives. |

What users on the audience see: the app drops out of their catalog at the
next manifest refresh (login or account rebuild) — no error, it is simply
no longer offered. The gate is real, not cosmetic: a disabled or removed
binding also stops *entitling* anyone to load that version's bundle, so a
pulled version cannot be resurrected by a stale link.

Choosing: **disable** is the pause you intend to reverse — an incident, a
version you want off the air while you investigate — and the still-visible
row is the reminder. **Remove** is the statement that you no longer serve
this audience at all, and it tidies the table. The Deploy tab's **Remove**
action on a where-live row is the remove verb; from scripts,
`client.removeAppPublish(appId, target)` performs remove, and disable rides
the same deploy command as its `disable` subcommand. For the `@public` row,
only the developer organization may do either.

### Testing a specific published version: the version override

Every registry version stays loadable forever, so testing an older (or a
not-yet-published) version never means republishing. Two ways in:

- **The version drop list** on the app's desktop tile — pick any version
  you are entitled to.
- **A deep link**: `?appid=<your.app>&version=<registry int>` (e.g.
  `?appid=acme.brandy&version=7`) — the registry version integer is the
  version's wire identity, and it is the only form the shell accepts. The
  `package.json` semver is display only; a non-integer value (`1.3.0`,
  `7abc`) is rejected outright rather than partially parsed, and the page
  falls back to normal resolution.

Both create a **session override**: it lives in the browser tab and dies
with it — deliberately never persisted server-side, so an override cannot
sit forgotten and quietly serve old code weeks later. Within the tab, the
resolution order is: URL `?version=` first, then the session override, then
your dev overlay, then the server's default for your rungs.

Mechanics worth knowing:

- **One version per page.** A loaded app is committed to its version for
  the life of the document — picking a different version after the app has
  loaded reloads the page once (before it loads, the switch is instant).
- **The dev build wins.** While your watch is serving the app, the dev
  overlay takes precedence over any override — stop the dev session to
  test served versions.
- **Entitlement is enforced per request.** You can load any version served
  on a rung visible to you (your `@me`, a team you belong to, the approved
  store version) — or any version you deployed yourself, published or not.
  That last rule is what makes the override the pre-publish smoke test:
  deploy, deep-link the new version, verify, then publish.
- **Going back**: pick the default entry in the drop list (one reload
  restores normal resolution), or just close the tab — the override dies
  with it.

### Automation

Everything the Deploy tab does is scriptable — the UI and the SDKs call the
same verbs (TypeScript camelCase / Python snake_case):

| Action | TypeScript verb |
|---|---|
| List versions | `client.listDeployments(appId)` |
| Deploy a source zip | `client.deploy.add({ kind: 'app', data, metadata })` |
| Publish to a rung | `client.publishApp(appId, version, target)` |
| Remove a binding | `client.removeAppPublish(appId, target)` |
| Where live | `client.whereApp(appId)` |
| Submit / withdraw review | `client.submitApp(...)` / `client.withdrawApp(...)` |
| Review thread reply | `client.replyApp(appId, message)` |
| Build log | `client.buildLog(appId, version)` |

The Python client mirrors every verb (`publish_app`, `submit_app`,
`where_app`, ...). See `ROCKETRIDE_typescript_API.md` and
`ROCKETRIDE_python_API.md` for client setup and the full reference.

---

## Reference: Complete API Surface

Everything importable from `'shell'`. (SDK types — payloads, results,
configs — are also re-exported type-only from `'shell'`, so
`import type { ConnectResult } from 'shell'` works everywhere.)

### Hooks

`useShellConnection()`, `useClient()`, `useConnectionStatus()`,
`useShellApiConfig()`, `useAuthUser()`, `useLogout()`,
`useSubscriptions()`, `useWorkspace()`, `usePrefs()`, `useShellEvent()`,
`useAppComponent()`, `usePolling()`, `useDebouncedValue()`,
`useAnnouncements()`, `useClickOutside()`, `useFixedPopupPosition()`,
`useSidebarCollapsed()`, `useDashboardData()`, `useIframeBridge()`

### Client access & events

`getClient()`, `ConnectionManager` (singleton class:
`getInstance()`, `on()`, `emit()`, `onAny()`, `getDebugLog()`,
`clearDebugLog()`, `isConnected()`, `getAccountInfo()`,
`getCachedServices()`, `refreshServices()`), `ConnectionState`

### Layout & documents

`AppLayout`, `Documents` (class), `DocTabs`, `DocSplitLayout`,
`DocExplorer`, `NOOP_VFS`, `Explorer`

### Stock UI components

`Button`, `StatusBadge`, `StatusDot`, `EmptyState`, `Banner`, `InputField`,
`ToggleGroup`, `Chip`, `ChipAdd`, `DropZone`, `Card`, `MiniCard`,
`MiniContainer`, `Section`, `LabelValue`, `ContentHeader`, `RocketRideMark`,
`DetailPanel`, `PanelTabBody`, `TabControl`, `TabPanel`, `Modal`,
`SaveFileDialog`, `ConfirmDialog`, `PopupRow`, `SidebarMenu`,
`SidebarFooter`, `SidebarCollapsedProvider`, `SidebarCollapsedGate`,
`DataGrid`, `CardDataGrid`, `FilterStrip` (+ grid helpers
`createActionsColumn`, `autoFormatter`, `badgeEl`, `buttonEl`, `avatarEl`,
`monoEl`, `mutedEl`, `matchesSearch`, `formatDateValue`), `ChatView`,
`MessageList`, `MarkdownRenderer`, `useChatMessages`, `ConnectionCard`,
`ConnectionCardAdd`, `ConnectionManagerView`, `MonitorView`, `AccountView`,
`EnvironmentView`, `CheckoutModal`, `PlanPicker`, `UpgradeModal`

### Styling, formatting, icons

`commonStyles`, `applyTheme`, `formatBytes`, `formatDate`, `formatDuration`,
`formatNumber`, `formatTime`, `formatUptime`, `formatTimeAgo`,
`formatDayTime`, `isInVSCode`, and the full `Bx*` icon set (`BxPlus`,
`BxTrash`, `BxCog`, `BxPlay`, ...) — browse them all in the App Builder's
Components gallery.

### Key types

`AppDescriptor`, `AppLayoutProps`, `ShellAppProps`, `AppManifestEntry`,
`ShellBrandingConfig`, `IWorkspaceContext`, `WorkspacePrefs`,
`WorkspaceState`, `AppWorkspaceState`, `SettingValue`, `SettingSchema`,
`AppConfiguration`, `IPrefsApi`, `ShellEventMap`, `ConnectionStatus`,
`DebugLogEntry`, `AuthUser`, `RocketRideClient`, the Documents model types
(`Document`, `Editor`, `EditorGroup`, `SplitOrientation`, `DocumentsState`,
`WorkspaceBinding`, `LayoutNode`), `IVirtualFileSystem`,
`DocExplorerProps`, `DocExplorerConfig`, `DocEntry`, `DocEntryStatus`,
`DocTabsProps`, `DocSplitLayoutProps`, `ThemeTokens`

---

## See Also

`ROCKETRIDE_CONCEPTS.md` (the shared platform model — lifecycle,
connection, the app/pipeline seams), `ROCKETRIDE_PIPELINES.md` (authoring
`.pipe` content, patterns, pitfalls), `ROCKETRIDE_COMPONENT_REFERENCE.md`
(every pipeline component), `ROCKETRIDE_typescript_API.md` /
`ROCKETRIDE_python_API.md` (the client SDKs — see §Apps for the
deploy/publish automation verbs), `ROCKETRIDE_OBSERVABILITY.md` (runtime
logs, lifecycle events, traces).
