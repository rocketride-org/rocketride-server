---
title: Deployments
sidebar_position: 4
---

# Deployments

Persist pipelines server-side and run them on a schedule. Accessed via
`client.deploy`; full method tables in the
[API reference](/clients/python/reference#deploy-clientdeploy).

## Teams as environments

`deploy.publish` snapshots a pipeline as an **immutable, sha256-locked artifact
version** in the org registry; `deploy.deploy` points a **team** (the environment —
Staging, Production, …) at a version. Promotion and rollback are the same pointer
move. Deploy targets are always explicit — there is no default-team fallback. Every
publish and pointer change lands in an immutable audit history
(`deploy.history`, rows carry `seq` as the stable append-order identity).

```python
result = await client.deploy.publish(my_pipeline, comment='v2 prompt fix')
await client.deploy.deploy('proj-1', result['artifact']['version'], 'team-staging')
await client.deploy.set_schedule('proj-1', 'webhook_1', '*/15 * * * *', 'team-staging')

# Promote the same version to Production later — the identical gesture.
await client.deploy.deploy('proj-1', result['artifact']['version'], 'team-prod')

live = await client.deploy.list()
for dep in live['rows']:
    print(dep['teamId'], dep['projectId'], 'v', dep['version'], dep['state'])
```

`publish(..., deploy_to=<team>)` collapses publish + deploy into one step. Listings
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

## App publish ladder

Shell apps have their own registry surface — typed wrappers over `rrext_app_deploy`.
**Publish** snapshots an immutable app version (never activates anything);
**Deploy** pins a rung (`@user`, `@team/<name-or-id>`, `@org`) to a version — first
publish, update, promote, and rollback are all this one verb.

| Method | Description |
| --- | --- |
| `app_publish(app_id, version, bundle, message='', module_id=None, name=None)` | Publish an immutable version to the org registry (single-file `remoteEntry.js` bundle; commit-style `message` shows on the version card). |
| `app_versions(app_id)` | The version rail, newest first; each entry carries `rungs` naming the rungs currently pinned to it. |
| `app_deploy(app_id, registry_version, target)` | Pin a rung to a version. Personal deploys resolve into your own manifest immediately. |
| `app_where(app_id)` | The reverse index: `{rung, handle, version, appVersion, state, deployedAt}` per rung. |

See the [Shell Apps guide](/guides/apps) for the app model itself.
