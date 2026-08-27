---
title: Deployments
sidebar_position: 4
---

# Deployments

Persist pipelines server-side and run them on a schedule. Accessed via
`client.deploy`; full method tables in the
[API reference](/clients/typescript/reference#deploy-clientdeploy).

## Teams as environments

`deploy.publish` snapshots a pipeline as an **immutable, sha256-locked artifact
version** in the org registry; `deploy.deploy` points a **team** (the environment —
Staging, Production, …) at a version. Promotion and rollback are the same pointer
move. Deploy targets are always explicit — there is no default-team fallback. Every
publish and pointer change lands in an immutable audit history (`deploy.history`,
rows carry `seq` as the stable append-order identity).

```typescript
const result = await client.deploy.publish(myPipeline, { comment: 'v2 prompt fix' });
await client.deploy.deploy('proj-1', result.artifact.version, 'team-staging');
await client.deploy.setSchedule('proj-1', 'webhook_1', '*/15 * * * *', 'team-staging');

// Promote the same version to Production later — the identical gesture.
await client.deploy.deploy('proj-1', result.artifact.version, 'team-prod');

const live = await client.deploy.list();
for (const dep of live.rows) {
	console.log(dep.teamId, dep.projectId, 'v', dep.version, dep.state);
}
```

`publish(pipeline, { deployTo })` collapses publish + deploy into one step.
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

## App publish ladder

Shell apps have their own registry surface — typed wrappers over `rrext_app_deploy`.
**Publish** snapshots an immutable app version (never activates anything);
**Deploy** pins a rung (`@user`, `@team/<name-or-id>`, `@org`) to a version — first
publish, update, promote, and rollback are all this one verb.

| Method | Description |
| --- | --- |
| `appPublish({ appId, version, bundle, message?, moduleId?, name? })` | Publish an immutable version to the org registry (single-file `remoteEntry.js` bundle; commit-style `message` shows on the version card). |
| `appVersions(appId)` | The version rail, newest first; each entry carries `rungs` naming the rungs currently pinned to it. |
| `appDeploy(appId, registryVersion, target)` | Pin a rung to a version. Personal deploys resolve into your own manifest immediately. |
| `appWhere(appId)` | The reverse index: `{rung, handle, version, appVersion, state, deployedAt}` per rung. |

See the [Shell Apps guide](/guides/apps) for the app model itself.
