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
`{rows, total, page, pageSize}` envelope, server-paged. `deploy.list` and
`deploy.history` take an optional `team_id` to scope the listing to one team.
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

The lifecycle, verb by verb: scaffold with `deploy.create_app`, pre-check with
`deploy.verify_app`, then pack and deploy with `deploy.add_app` (or the raw
`deploy.add(kind='app', data=...)` door for a zip you packed yourself). Watch
the build on the version rail (`list_deployments`, `build_log`), take a version
through store review (`submit_app`, `withdraw_app`, `reply_app`), and bind it to
an audience with `publish_app`. `where_app` shows which audiences serve which
version. `disable_app_publish` pauses a binding (its row stays visible, marked
disabled) and `remove_app_publish` drops it; both are soft, and publishing to the
audience again restores it.

The four `deploy.`-prefixed verbs live on `client.deploy`; every other verb is a
method on the client itself (`client.list_deployments(...)`,
`client.publish_app(...)`), not on `client.deploy`.

Serving needs no verb: a version's bundle loads from the stable
`/apps/<app_id>/v<N>/remoteEntry.js` URL constructed from its registry
version number, with entitlement enforced by the serve route on every
request (registry ints ONLY — semver is display).

Full signatures: [API reference](/clients/python/reference#app-publish-ladder).

See the [Shell API guide](/guides/apps) for the app model itself.
