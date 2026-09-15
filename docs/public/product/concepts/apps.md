---
title: Apps
---

# Apps

A **RocketRide app** is a user interface that runs inside the RocketRide
shell against your engine. The shell provides sign-in, the engine
connection, the workspace, and settings; the app brings the screens and the
pipelines behind them. Apps run in the browser or in a VS Code webview;
the pipelines they start always run on the server.

## Why apps

To a user, an app turns a pipeline's work into a tool a teammate opens,
not a script someone has to run themselves.

To RocketRide, the same engine, node catalog, and deploy path serve both
pipelines and the interfaces built on top of them, and the catalog of apps
is how that work is shared inside an organization.

## Apps and pipelines

A pipeline can belong to an app, or stand beside it. The difference decides who runs it and when.

**Bundled with the app.** The `.pipe` file lives in the app folder and ships with the app. The app starts it when it needs it, for example when the user runs a query, and every signed-in user gets their own instance, automatically. A bundled pipeline is never shared between users and cannot run on a schedule.

**Deployed on its own.** The pipeline is its own project, deployed
separately from the app. One instance serves everyone on the team it is
published to, and it can run on a schedule. The app refers to it by
identity and attaches to whatever is running; it does not start it.

A `.pipe` file outside the app folder is not deployed with the app. If the
app needs it, deploy it separately.

Secrets never ship in either case: pipeline configs carry
`${ROCKETRIDE_*}` placeholders that the server fills from the signed-in
user's stored keys.

## Next steps

- [App Builder](/guides/apps/app-builder): build, preview, and deploy an app.
- [Pipelines](/concepts/pipelines): what the app is running.
- [Shell API](/guides/apps): the hooks and descriptor, when you code by hand.
