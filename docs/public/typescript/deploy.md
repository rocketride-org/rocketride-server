---
title: Deployments
sidebar_position: 4
---

# Deployments

Persist pipelines server-side and run them on a schedule. Accessed via
`client.deploy`; full method tables in the
[API reference](/clients/typescript/reference#deploy-clientdeploy).

## Teams as environments

`deploy.add` snapshots a pipeline as an **immutable, sha256-locked artifact
version** in the org registry; `deploy.deploy` points a **team** (the environment —
Staging, Production, …) at a version. Promotion and rollback are the same pointer
move. Deploy targets are always explicit — there is no default-team fallback. Every
registry add and pointer change lands in an immutable audit history (`deploy.history`,
rows carry `seq` as the stable append-order identity).

```typescript
const result = await client.deploy.add({ pipeline: myPipeline, comment: 'v2 prompt fix' });
await client.deploy.deploy('proj-1', result.artifact.version, 'team-staging');
await client.deploy.setSchedule('proj-1', 'webhook_1', '*/15 * * * *', 'team-staging');

// Promote the same version to Production later — the identical gesture.
await client.deploy.deploy('proj-1', result.artifact.version, 'team-prod');

const live = await client.deploy.list();
for (const dep of live.rows) {
	console.log(dep.teamId, dep.projectId, 'v', dep.version, dep.state);
}
```

`add({ pipeline, deployTo })` collapses add + deploy into one step.
Listings (`deploy.list`, `deploy.versions`, `deploy.history`) return the standard
`{ rows, total, page, pageSize }` envelope, server-paged.
`deploy.artifact(projectId, version)` fetches one immutable version's pipeline
JSON, sha256-verified server-side.

## Schedules

`deploy.setSchedule(projectId, sourceId, schedule, teamId, options?)` sets (or
clears with `null`/`'manual'`) one source's 5-field cron schedule.
`pauseSchedule`/`resumeSchedule` stop and restart a single source's firing without
touching its cron. `deploy.preview(schedule, count?)` is **the** single cron
evaluator — validity plus next occurrences; never parse cron client-side.

Scheduled runs execute **as the team** (no stored user credential); their logs
land in the team's [run-log continuum](/clients/typescript/logs), readable by
teammates via `client.log` with `teamId`. `deploy.run(projectId, sourceId, teamId)`
triggers one deployed source **now** — the same trusted, actor-free team dispatch
the scheduler uses — returning `{ token, version }`, and
`deploy.setSourceConfig` sets per-source execution settings for deploy runs
(`traceLevel`, `debugOut`).

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
(`deploy.add`); a deployment carries the review lifecycle in its own `state`
(`private` → `submit` → `ready` | `rejected`). **Publish** binds a deployment
to an audience — `@me`, `@team/<name>`, or `@public` — as a pure pointer (`@user` is a legacy input alias for `@me`, never displayed);
repointing it covers first publish, update, promote, and rollback alike.

The review state lives on the **deployment**, not the binding: an app deploys
`private` (internal-eligible), the developer `submit`s it for review, an admin
approves (`ready`) or rejects (`rejected`). A `@public` binding may only point
at a `ready` deployment; `@me`/`@team` bindings accept any internal-eligible
(not `failed`) deployment. So there is no separate "publish-and-wait" — public
listing is: submit → approve → repoint the public pointer.

App ids are partitioned by the caller org's **developer id**: every app is
`<developerId>.<name>` (globally unique), so an org can only deploy/publish
ids inside its own namespace — the platform holds `rocketride`. Deploying or
publishing an app requires the org to have claimed a developer id.

`deploy.add` and `deploy.addApp` live on `client.deploy`; every other verb
below is a method on the client itself (`client.listDeployments(...)`,
`client.publishApp(...)`), not on `client.deploy`.

| Method | Description |
| --- | --- |
| `deploy.add` | The ONE rail door: deploy any kind of object as the next immutable registry version. `kind:'pipe'` (default) takes a `pipeline` dict; `kind:'app'` takes ONE `data` zip of the app's SOURCE — the server performs the build (client-produced binaries are never trusted); the zip is retained and unpacked at receipt, born deployment-state `private`. The app id must be inside your developer namespace. |
| `deploy.addApp` | Pack an app folder's source and deploy it as the next registry version — the one call behind the App Builder's Deploy button and CI scripts. Packs by the App Builder rules (workspace-rooted zip, `appManifest.include`, hierarchical gitignore + the hard node_modules/dist/.git baseline, symlink containment, 50MB zipped / 512MB uncompressed caps); `onProgress` receives one line per step. Deploying activates nothing — bind an audience with `publishApp` afterwards. |
| `deploy.verifyApp` | The no-side-effect precheck for `addApp` — purely local, no server call: manifest shape and id grammar, declared icon/README assets, `appManifest.include` entries, and a pack dry run against the size caps. Server-side concerns (the build, store review) are out of scope. |
| `listDeployments` | The version rail, newest first — the developer org sees its FULL rail (published or not), other callers only their visible versions. Each entry carries its deployment `state`, its `buildStatus` ('ok' = servable), and the `rungs` naming the audiences bound to it. |
| `submitApp` | Submit a deployed version for store review — flips the deployment `private` → `submit` (it enters the admin queue). Developer-org + namespace gated. |
| `withdrawApp` | Withdraw a pending review — the developer's own cancel: flips the deployment `submit` → `private` (leaves the admin queue, back to draft; history records `withdrawn`). Only a version in `submit` withdraws. Developer-org + namespace gated. |
| `replyApp` | Append a developer message to the app's review thread — the developer half of the reviewer conversation. Rides `deployment_history` as a `reply` row (side `'developer'`), the same stream `deploy.history()` reads. Developer-org + namespace gated. |
| `buildLog` | One version's durable server build log — the full phase-by-phase output the build worker stores beside the version's artifacts (no error text rides the rail rows). Long logs serve their tail; `''` = no log. Developer-org gated. |
| `publishApp` | Bind a deployment to '@me', '@team/<name>', or '@public' ('@user' = legacy input alias). The binding is a pure pointer born 'enabled'. `@public` requires the deployment be `ready` (approved); `@me`/`@team` accept any non-`failed` deployment. Pinning ANOTHER org's public app to '@me'/'@team' is the version selector and is allowed; publishing your own app requires the id to be in your namespace. |
| `whereApp` | The reverse index: `{rung, handle, version, appVersion, state, deployedAt}` per audience — `state` is the bound DEPLOYMENT's review state. |

Serving needs no verb: a version's bundle loads from the stable
`/apps/<appId>/v<N>/remoteEntry.js` URL constructed from its registry
version number, with entitlement enforced by the serve route on every
request (registry ints ONLY — semver is display).

Full signatures: [API reference](/clients/typescript/reference#app-publish-ladder).

See the [Shell API guide](/guides/apps) for the app model itself.
