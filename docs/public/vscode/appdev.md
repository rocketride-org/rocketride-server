# App Builder (app development surface)

The VS Code extension hosts the **App Builder** — the surface for developing,
previewing, and deploying RocketRide apps. This page documents the contracts
that surface exposes; the runtime lives under `apps/vscode/src/appdev/` and
`apps/vscode/src/providers/AppScreenProvider.ts`.

## The `.rrapp` trigger (contentless marker)

`<folder>/<name>.rrapp` is a **contentless** trigger file. Double-clicking it
in the Explorer opens the App Builder, and VS Code uses it for tab identity.
It carries no data: everything about the app — `id`, `name`, and the
working-copy `projectId` — lives in one place, the folder's `package.json`
`appManifest` block.

- `projectId` is a client-side GUID that distinguishes one working copy
  (checkout, duplicate) of an app from another. It is never a server key —
  deploys record it only as `metadata.projectId` provenance.
- **Migration:** legacy markers that still carry `{ id, projectId }` JSON are
  migrated on first `ensure` — the `projectId` is adopted into the folder's
  `appManifest` and the marker is emptied.

## MY APPS sidebar (scan-only)

The App Builder sidebar's `apps` list is built **from the workspace scan
alone** — every row is a `.rrapp`-bound local working copy discovered under the
open workspace folders. It is not merged with the server `list_mine` catalog.
Discovery is driven by `.rrapp`/`package.json` file events and by
workspace-folder changes; there is no rescan on connect.

## Live preview overlay & dev servers

A local dev build is previewed by registering a per-user `moduleId → entry URL`
overlay (via `rrext_deploy_app.register_dev`) so the developer's shell points at
their locally built bundle. The extension manages the underlying rsbuild dev
servers through a serialized per-app operation chain (start/stop/restart run one
at a time). Closing a preview **lingers** the server for 60 s so a quick reopen
revives it instantly; a Reload or extension deactivation stops immediately.
Every dev server is **owned** by the current extension host and runs under a
guard wrapper whose stdin tether kills it the moment the host dies (window
reload, crash, EDH stop — any death mode), so orphaned dev servers cannot
exist. A server that crashes while its panel is open respawns itself
automatically (bounded, so a crash loop gives up and points at the Console).
The dev overlay holds one registration **per editor session** — several
editors (or windows) can dev-serve the same app concurrently; previews
launched from an editor carry its `rrsession` nonce and resolve that
editor's server, and shells without a nonce take the newest registration.

## `appdev:call` — the app-control message

The webview drives all app lifecycle actions through one correlated message:

```text
{ type: 'appdev:call', id, appId, method, args?: unknown[] }
```

The host replies on the same `id`:

```text
{ type: 'appdev:result', id, ok: true,  value }   // success
{ type: 'appdev:result', id, ok: false, error }   // failure (error is a string)
```

Registry-version arguments are validated as integers before any write (a
missing/non-numeric version is rejected, not sent as `null`).

| `method`          | args                          | returns |
| ----------------- | ----------------------------- | ------- |
| `listVersions`    | —                             | the version rail: one entry per registry version `{ registryVersion, appVersion, state, ... }` |
| `where`           | —                             | the audience pins currently serving the app `{ audience, version, ... }` |
| `deploy`          | `[sourceZipComment?]`         | packs the app SOURCE and deploys it (server builds it); returns the new rail entry |
| `submit`          | `[registryVersion]`           | flips the deployment `private → submit` (enters review) |
| `publish`         | `[registryVersion, target]`   | binds a version to an audience (`@me`/`@team`/`@public`) |
| `withdraw`        | `[registryVersion]`           | cancels a pending review (`submit → private`) |
| `unpublish`       | `[target]`                    | removes an audience binding (soft — republishing revives) |
| `teams`           | —                             | the caller's org teams `[{ id, name }]` |
| `developerStatus` | —                             | the org's developer-namespace registration status |
| `registerDeveloper` | `[developerId]`             | claims the org's developer-id slug |
| `loadListing` / `saveListing` | `[listing?]`      | read/write the app's store listing metadata |
| `preflight`       | —                             | pre-submit checks (app entry point + rsbuild config present) |
| `history`         | —                             | the app's full `deployment_history` stream, **oldest-first** — audit rows plus the review thread (`reply` rows); the host walks the server's 100-row pages. Rows are self-describing: audience rows carry the dereferenced `name`/`handle` (plus `previousVersion` on a repoint), deploy rows the deploy `comment`, review rows their `from`/`to` states — the view never needs a second lookup |
| `reply`           | `[message, registryVersion?]` | appends a developer message to the review thread (side `'developer'`) |
| `buildLog`        | `[registryVersion]`           | one version's durable server build log (phase-by-phase output; `''` = no log) — the Deploy card's `failed` badge opens it |
| `pickFile`        | `['icon' \| 'readme']`        | native file picker for a manifest asset; returns the APP-FOLDER-relative `./`-prefixed path (picks outside the app folder are refused — the server only serves app-relative assets) or `null` on cancel |
| `readFile`        | `[appRelativePath]`           | one app-folder-relative text file (icon SVG / README markdown) for preview; traversal-guarded, 512KB cap |
| `readImage`       | `[appRelativePath]`           | one app-folder-relative image as a data: URI (README images are binary; mime by extension, 256KB cap, `null` when unservable) — the README viewer resolves relative image refs against the README's own directory through this |

Deploy packages the app's **source** — `dist/` is never uploaded; the server
injects platform deps and performs the build. The packed zip is capped at
**50 MB zipped** (refused client-side at pack time and again by the server
before parsing); an over-cap pack almost always means an over-broad
`appManifest.include` entry.

## Stage persistence

The App Builder's active tab (`dashboard | design | package | store |
deploy`) persists per app in `workspaceState` under `appdev.stage.<appId>`.
Values are normalized on read: the legacy `'develop'` id (pre-rename) maps
to `'design'`, and anything unknown (or never persisted) lands on
`'dashboard'`, the default landing view. Writes store the raw id.

PACKAGE carries everything an app needs regardless of the store (identity,
icon, README, `appManifest.include` pack roots, and the personal-readiness
checks); STORE carries commerce only (mode, pricing plans, submission, and
review history). The `preflight` checks are tiered accordingly (`tier:
'package' | 'store'`), and Submit-for-review gates on both tiers.

PACKAGE also carries the strict-type-checking waiver:
`appManifest.typecheck: false` makes the server build SKIP its verify phase
(the user's own `tsc --noEmit`) and bundle anyway — the waiver is recorded in the
version's build.log and surfaces as a standing warn row in the readiness
checks. Absent/`true` = strict, the default.

## Account & checkout messages

- `{ type: 'account:setDevTeam', teamId }` — set the caller's development team
  for the active org (dev-run billing + environment layer). Per-org selection.
- `{ type: 'checkout:getStripeKey', requestId }` → host replies
  `{ type: 'checkout:stripeKey', key, requestId, reason? }`. The publishable key
  is fetched at runtime from the connected server's public probe (never baked
  into the build). When the key is empty, `reason` explains why
  (`'no-connection' | 'probe-failed' | 'no-billing'` — the last means the probe
  SUCCEEDED but the server has no billing configured, a terminal state the hook
  stops retrying) so the webview can show a message instead of a dead
  Subscribe button. The requesting hook re-requests when a connection
  lands (a server switch invalidates the previous key), and the `requestId`
  echo lets it drop a stale reply from a prior server that races in after the
  re-request.
