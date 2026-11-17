---
title: App Builder
sidebar_position: 4
---

# App Builder

The App Builder is the extension's workbench for building apps that run
inside the RocketRide shell. The loop (create, design, package, deploy)
and how pipelines fit into an app are documented in the
[App Builder guide](/guides/apps/app-builder). This page covers the
extension surface around it.

## Opening it

- **RocketRide: New App** in the command palette (or **New App** in the
  sidebar's app list) scaffolds an app into `apps/` and opens the builder.
- Switch the RocketRide sidebar to apps mode: **MY APPS** lists the
  `.rrapp`-bound apps found in your open workspace folders. Clicking a row
  opens its App Builder.
- Opening an app's `<name>.rrapp` file opens the builder for that app.

## Settings

The watch session always starts automatically when an App Builder opens.
App-related preferences (such as the default `apps/` scaffold directory) live
in the **RocketRide Settings page** under *Rocket Builder ▸ Apps* — they are
workspace settings stored on the connected server, not VS Code configuration.

## Debugging

Press F5 (**Debug App**) to open the previewed app in an external browser
with the debugger attached.

See the [App Builder guide](/guides/apps/app-builder) for everything else,
and the [Shell API](/guides/apps) for the hooks and descriptor the scaffold
gives you.
