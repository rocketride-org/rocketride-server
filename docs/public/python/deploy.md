---
title: Deployments
sidebar_position: 4
---

# Deployments

Persist pipelines server-side and run them on a schedule. Accessed via
`client.deploy`; full method tables in the
[API reference](/clients/python/reference#deploy-clientdeploy).

## Teams as environments

`deploy.add` snapshots a pipeline as an **immutable, sha256-locked artifact
version** in the org registry; `deploy.deploy` points a **team** (the environment —
Staging, Production, …) at a version. Promotion and rollback are the same pointer
move. Deploy targets are always explicit — there is no default-team fallback. Every
registry add and pointer change lands in an immutable audit history
(`deploy.history`, rows carry `seq` as the stable append-order identity).

```python
result = await client.deploy.add(my_pipeline, comment='v2 prompt fix')
await client.deploy.deploy('proj-1', result['artifact']['version'], 'team-staging')
await client.deploy.set_schedule('proj-1', 'webhook_1', '*/15 * * * *', 'team-staging')

# Promote the same version to Production later — the identical gesture.
await client.deploy.deploy('proj-1', result['artifact']['version'], 'team-prod')

live = await client.deploy.list()
for dep in live['rows']:
    print(dep['teamId'], dep['projectId'], 'v', dep['version'], dep['state'])
```

`add(..., deploy_to=<team>)` collapses add + deploy into one step. Listings
(`deploy.list`, `deploy.versions`, `deploy.history`) return the standard
`{rows, total, page, pageSize}` envelope, server-paged.
`deploy.artifact(project_id, version)` fetches one immutable version's pipeline
JSON, sha256-verified server-side.

## Schedules

`deploy.set_schedule(project_id, source_id, schedule, team_id, ttl=None)` sets (or
clears with `None`/`'manual'`) one source's 5-field cron schedule.
`pause_schedule`/`resume_schedule` stop and restart a single source's firing without
touching its cron. `deploy.preview(schedule, count=None)` is **the** single cron
evaluator — validity plus next occurrences; never parse cron client-side.

Scheduled runs execute **as the team** (no stored user credential); their logs land
in the team's [run-log continuum](/clients/python/logs), readable by teammates via
`client.log` with `team_id`. `deploy.run(project_id, source_id, team_id)` triggers
one deployed source **now** — the same trusted, actor-free team dispatch the
scheduler uses — returning `{token, version}`, and `deploy.set_source_config` sets
per-source execution settings for deploy runs (trace level, debug output).

## States

| State | Meaning |
| --- | --- |
| `enabled` | Schedules fire per cron. |
| `disabled` | The kill switch (`deploy.disable`) — nothing runs until enabled again. |
| `errored` | A scheduled dispatch failed — on permissions, or on an unusable artifact (missing or sha256-tampered) — and the scheduler stopped retrying. |
| `removed` | Soft delete (`deploy.remove`): hidden from listings, history and artifacts survive; re-deploying revives it. |

## Permissions

Mutations require `task.control` on the TARGET team. Reads follow the visibility model: an org admin sees every team and every personal space; a user sees their own personal space and the teams they are a member of.

## App publish ladder

Typed wrappers over `rrext_deploy_app` — the publish ladder for RocketRide apps.
**Deploy** copies code to the server as the next immutable registry version
(`client.deploy.add`); a deployment carries the review lifecycle in its own `state`
(`private` → `submit` → `ready` | `rejected`). **Publish** binds a deployment to
an audience — `@me`, `@team/<name>`, or `@public` — as a pure pointer (`@user` is a legacy input alias for `@me`, never displayed);
repointing it covers first publish, update, promote, and rollback alike.

The review state lives on the **deployment**, not the binding: an app deploys
`private`, the developer `submit`s it, an admin approves (`ready`) or rejects
(`rejected`). A `@public` binding may only point at a `ready` deployment;
`@me`/`@team` accept any non-`failed` deployment.

App ids are partitioned by the caller org's **developer id**: every app is
`<developerId>.<name>` (globally unique), so an org can only deploy/publish
ids inside its own namespace (the platform holds `rocketride`). Deploying or
publishing an app requires the org to have claimed a developer id.

`deploy.add` and `deploy.add_app` live on `client.deploy`; every other verb
below is a method on the client itself (`client.list_deployments(...)`,
`client.publish_app(...)`), not on `client.deploy`.

| Method | Description |
| --- | --- |
| `deploy.add` | The ONE rail door (on the `client.deploy` namespace): deploy any kind of object as the next immutable registry version. `kind='pipe'` (default) takes a `pipeline` dict; `kind='app'` takes ONE `data` zip of the app's SOURCE (the server performs the build; client-produced binaries are never trusted), retained and unpacked at receipt, born deployment-state `private`. The app id must be inside your developer namespace. |
| `deploy.add_app` | Pack an app folder's source and deploy it as the next registry version — the one call behind the App Builder's Deploy button and CI scripts. Packs by the App Builder rules (workspace-rooted zip, `appManifest.include`, hierarchical gitignore + the hard node_modules/dist/.git baseline, symlink containment, 50MB zipped / 512MB uncompressed caps); `on_progress` narrates one line per step. Deploying activates nothing — bind an audience with `publish_app` afterwards. |
| `deploy.verify_app` | The no-side-effect precheck for `add_app` — purely local, no server call: manifest shape and id grammar, declared icon/README assets, `appManifest.include` entries, and a pack dry run against the size caps. Server-side concerns (the build, store review) are out of scope. |
| `list_deployments` | The version rail, newest first — the developer org sees its FULL rail (published or not), other callers only their visible versions. Each entry carries its deployment `state`, its `buildStatus` ('ok' = servable), and the `rungs` naming the audiences bound to it. |
| `submit_app` | Submit a deployed version for review — flips the deployment `private` → `submit`. |
| `withdraw_app` | Withdraw a pending review — the developer's own cancel: flips the deployment `submit` → `private`, the version leaves the admin queue and history records `withdrawn`. Only a version in `submit` withdraws. Developer-org + namespace gated, like submit. |
| `reply_app` | Append a developer message to the app's review thread — rides `deployment_history` as a `reply` row (side `'developer'`), the same stream `deploy.history()` reads. Developer-org + namespace gated, like submit. |
| `build_log` | One version's durable server build log — the full phase-by-phase output stored beside the version's artifacts (no error text rides the rail rows). Long logs serve their tail; empty `log` = none. Developer-org gated. |
| `publish_app` | Bind a deployment to '@me', '@team/<name>', or '@public' ('@user' = legacy input alias). The binding is a pure pointer born 'enabled'. '@public' requires the deployment be `ready`; '@me'/'@team' accept any non-`failed` deployment. Pinning ANOTHER org's public app to '@me'/'@team' is the version selector; publishing your own app requires the id to be in your namespace. |
| `where_app` | The reverse index: `{rung, handle, version, appVersion, state, deployedAt}` per audience — `state` is the bound deployment's review state. |

Serving needs no verb: a version's bundle loads from the stable
`/apps/<app_id>/v<N>/remoteEntry.js` URL constructed from its registry
version number, with entitlement enforced by the serve route on every
request (registry ints ONLY — semver is display).

Full signatures: [API reference](/clients/python/reference#app-publish-ladder).

See the [Shell API guide](/guides/apps) for the app model itself.
