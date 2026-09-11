---
title: App Builder
sidebar_position: 4
---

# App Builder

The App Builder is a workbench inside the extension for building
[Shell Apps](/guides/apps) — custom apps that run inside the RocketRide
shell — without leaving VS Code. It takes you from an empty folder to a live
preview against a real engine, then to published, deployable versions.

The journey:

1. **RocketRide: New App** scaffolds an app from a template into your
   workspace.
2. The App Builder opens with a live preview — save a file and the preview
   rebuilds.
3. **Publish** snapshots an immutable version.
4. **Deploy** points a rung — personal, team, or org — at a version.

## Prerequisites

- An open workspace, with Node and pnpm installed — the builder scaffolds
  into `apps/` and runs the dev server locally.
- A connected engine (Development Mode). Scaffolding works offline, but the
  live preview, publishing, and deploying need the connection.

## Create an app

Run **RocketRide: New App** from the command palette (or the **New App**
button in the sidebar's app list). The wizard asks for:

- **Name** — the app id becomes `<publisher>.<name>`, where the publisher
  comes from your connected server's organization (`local` when offline).
- **Template** — **Blank** (a minimal app component) or **Dashboard** (stat
  cards and a chart, styled with shell tokens).
- **Frame** — checkboxes for the shell chrome your app starts with: sidebar,
  status footer, document tabs.

The scaffold is a standard [app-sdk project](/guides/apps): a
`package.json` with the `appManifest` block, a Module Federation config
exposing `./AppDescriptor`, and an `AppDescriptor` in `src/` — plus a
`<name>.rrapp` marker file. Opening that marker file *is* opening the App
Builder for the app. Dependencies install once at the workspace root; the
platform types ship vendored with the scaffold, so there is nothing extra to
configure.

Your apps appear in the sidebar's **MY APPS** list (switch the RocketRide
sidebar to its apps mode) — a merge of what's in your workspace and what the
connected server knows about; clicking a row opens its App Builder.

## The Develop view

The first tab is the inner loop, organized as panes:

- **Preview** — the real engine-served shell with your app loaded and your
  local dev bundle injected. The toolbar has zoom/fit, device-size presets, a
  light/dark preview theme toggle, and an **Inherit Auth** checkbox (reuse
  your signed-in session in the preview, or let it run its own sign-in).
  Preferences persist per app.
- **Components** — a live gallery of the shell's public API: 47 components,
  hooks, and utilities in six groups, each with docs, a running demo with
  adjustable knobs, and a copyable usage snippet. This is the fastest way to
  learn what the shell gives you.
- **Console** — one filterable feed merging shell events, app console
  output (including install/build output), and errors.

A watch session (**DEV** badge on the toolbar) runs `rsbuild dev` for the
app: every save rebuilds the bundle, re-registers your personal dev overlay
on the connected engine, and reloads the preview. The overlay is yours alone
and ephemeral — it disappears when the panel closes or the connection drops,
so a dev bundle can never leak to other users. **Preview Reload** resets the
whole inner loop (reinstall, fresh dev server). Editing `package.json`
re-runs the install automatically.

Two settings control the loop:

| Setting | Default | Meaning |
| --- | --- | --- |
| `rocketride.appdev.autoWatch` | `true` | Start the watch session automatically when an App Builder opens |
| `rocketride.appdev.shellUrl` | `""` | Override the preview shell base URL (empty = the Development Mode engine). For developers running a local shell dev server — the origin must match the connected server, or the preview can't see your dev overlay |

Press F5 (**Debug App**) to open the previewed app in an external browser
with the debugger attached.

## Publish and deploy

The **Deploy** tab implements a simple contract: **publish immutable
versions, then pin rungs to them.**

- **Publish** always runs a fresh production build (your dev output is never
  uploaded) and pushes the bundle to the engine's registry as a new
  version — author, time, and a commit-style message attached. Publishing
  never activates anything.
- **Deploy** points a rung — `@user` (personal), `@team/<name>`, or `@org` —
  at a published version. The same verb covers first release, update,
  promotion, and rollback: repoint, never rebuild. The **"Where this app is
  live"** panel shows every rung, its pinned version, and its audience.

Deployed apps are served to their audience through the engine — they load in
the shell like any installed app. No review is involved for personal, team,
or org rungs.

Current limits worth knowing: bundles are single-file (template-scale apps),
the deploy-target input is a plain prompt for now, and the **Store** tab —
public marketplace listing, pre-flight, and review — is visible but not yet
wired: deploying to the public rung isn't available today.

## Relation to the Shell Apps guide

The [Shell Apps guide](/guides/apps) documents the app-sdk itself — the
`AppDescriptor`, hooks, components, and manifest the builder scaffolds for
you — and the [reference](/guides/apps/reference) lists the full API
surface. Build with the App Builder, read the guide when you want to know
what the generated pieces mean.
