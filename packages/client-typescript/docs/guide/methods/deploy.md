---
title: "Deploy"
date: 2026-06-12
---

- [Overview](#overview)
- [Methods](#methods)
- [The list envelope](#the-list-envelope)
- [Schedules](#schedules)
- [Record shapes](#record-shapes)
- [Usage Examples](#usage-examples)
- [Deployment States](#deployment-states)
- [Error Handling](#error-handling)
- [API Endpoints](#api-endpoints)
- [Related Methods](#related-methods)

## **Overview**

The `client.deploy` namespace manages **teams-as-environments deployments**:

- **`publish()`** snapshots a pipeline as an **immutable, sha256-locked
  artifact version** in your organization's registry. Publishing puts
  nothing live.
- **`deploy()`** points a **team** at a published version. Teams are the
  environments (Staging, Production, ...): promotion and rollback are the
  same pointer move aimed at a different version or team. Deploy targets are
  always explicit — there is no default-team fallback.
- Every publish and every pointer change is recorded in an **immutable audit
  history** (who did what, where, when).

Scheduled runs execute **as the team** — no stored user credential — and
their logs land in the team's run-log continuum, readable by teammates via
[`client.log`](./log) with `teamId`.

## **Methods**

| Method | Description |
| --- | --- |
| `deploy.publish(pipeline, options?)` | Snapshot the pipeline as the next registry version (`options.deployTo` also deploys it in one step) |
| `deploy.deploy(projectId, version, teamId)` | Point a team at a version — promotion and rollback alike |
| `deploy.list(params?)` | Deployments visible to you, standard list envelope |
| `deploy.get(projectId, teamId)` | One team's deployment, registry-joined |
| `deploy.versions(projectId, params?)` | Registry versions (the version strip), newest first |
| `deploy.history(projectId, params?)` | The immutable audit trail, newest first, server-paged |
| `deploy.disable(projectId, teamId)` | The kill switch: NOTHING runs until enabled again |
| `deploy.enable(projectId, teamId)` | Enable a disabled deployment |
| `deploy.remove(projectId, teamId)` | Soft remove — history and artifacts survive forever |
| `deploy.setSchedule(projectId, sourceId, schedule, teamId, options?)` | Set (or clear with `null`) one source's cron schedule; the paused flag is untouched |
| `deploy.pauseSchedule(projectId, sourceId, teamId)` | Pause ONE schedule — cron/ttl kept, it just stops firing |
| `deploy.resumeSchedule(projectId, sourceId, teamId)` | Resume a paused schedule |
| `deploy.preview(schedule, count?)` | THE single cron evaluator: validity + next occurrences |

### Python (async)

```python
result = await client.deploy.publish(pipeline, comment='v2 prompt fix')
await client.deploy.deploy('proj-1', result['artifact']['version'], 'team-staging')
await client.deploy.set_schedule('proj-1', 'webhook_1', '*/15 * * * *', 'team-staging')
live = await client.deploy.list()
await client.deploy.remove('proj-1', 'team-staging')
```

### TypeScript

```typescript
const { artifact } = await client.deploy.publish(pipeline, { comment: 'v2 prompt fix' });
await client.deploy.deploy('proj-1', artifact.version!, 'team-staging');
await client.deploy.setSchedule('proj-1', 'webhook_1', '*/15 * * * *', 'team-staging');
const live = await client.deploy.list();
await client.deploy.remove('proj-1', 'team-staging');
```

## **The list envelope**

`list()`, `versions()`, and `history()` return the platform's standard list
envelope and accept the standard arguments:

```typescript
const page = await client.deploy.history('proj-1', {
	teamId: 'team-prod',
	page: 1,
	pageSize: 25,
	search: 'rollback',
	filters: { at__gte: 1750000000 }, // epoch seconds
	sort: [{ field: 'seq', dir: 'desc' }],
});
// -> { rows: [...], total: 87, page: 1, pageSize: 25 }
```

`history` is paged **by the server** (the trail is unbounded by design);
its rows carry `seq` — the stable append-order key that never ties — use it
as the row identity.

## **Schedules**

Schedules are **per source** on a team deployment. The `schedule` value:

| Value | Meaning |
| --- | --- |
| 5-field cron expression | e.g. `"*/15 * * * *"` — fire every 15 minutes |
| `"manual"` / `null` (TS) / `None` (Python) | Clear the schedule — no scheduled runs |

Invalid cron strings are rejected. Use `preview()` for validation and
next-occurrence rendering — never parse cron client-side, so what you show
can never disagree with what the scheduler fires.

A schedule can be **paused** without losing its cron/ttl
(`pauseSchedule`/`resumeSchedule`); editing the schedule with `setSchedule`
never changes the paused flag. This is distinct from **disabling the
deployment** (`disable`), which stops everything at once.

## **Record shapes**

`Deployment` (from `deploy`/`get`/`enable`/`disable`/`remove`/`setSchedule`,
and as `list()` rows):

| Field | Type | Description |
| --- | --- | --- |
| `teamId` / `projectId` | `string` | The deployment's identity |
| `version` | `number` | The registry version this team points at |
| `state` | `string` | `"enabled"` \| `"disabled"` \| `"errored"` \| `"removed"` |
| `pipelineName` | `string` | From the pointed-at artifact |
| `schedules` | `Record<string, DeploymentSchedule>` | Per-source schedules (`cron`, `paused`, `ttl`, `lastRunAt`) |
| `createdBy` / `updatedBy` | `DeployActor` | Denormalized audit identity |
| `deployedAt` | `number` | Latest pointer move (deploy/rollback) — the "deployed on" stamp; never bumped by disable/enable or schedule edits |
| `sha256` / `publishedAt` / `publishedBy` | | Registry-joined fields of the pointed-at version |

`DeployArtifact` (from `publish`, and as `versions()` rows): `version`,
`sha256`, `bytes`, `pipelineName`, `publishedBy`, `publishedAt`, `comment`.

`DeployHistoryEntry` (as `history()` rows): `seq`, `at`, `action`
(`publish` | `deploy` | `rollback` | `enable` | `disable` | `errored` |
`remove`; `pause`/`resume` appear only on rows written before the
enable/disable vocabulary), `teamId` (`''` on org-wide publish rows),
`version`, `actor`.

## **Usage Examples**

### Publish and deploy in one step (small-team path)

```python
result = await client.deploy.publish(my_pipeline, deploy_to='team-prod')
print(result['deployment']['version'], result['deployment']['state'])
```

### Staged rollout with rollback

```typescript
// Publish once, verify on Staging, promote the SAME artifact to Production.
const { artifact } = await client.deploy.publish(pipeline, { comment: 'RC1' });
await client.deploy.deploy('proj-1', artifact.version!, 'team-staging');
// ... verify ...
await client.deploy.deploy('proj-1', artifact.version!, 'team-prod');

// Rollback is the same gesture aimed at the previous version.
await client.deploy.deploy('proj-1', artifact.version! - 1, 'team-prod');
```

### Audit: who put what live where

```typescript
const trail = await client.deploy.history('proj-1');
for (const row of trail.rows) {
	console.log(row.seq, row.action, row.teamId, 'v' + row.version, row.actor?.display);
}
```

## **Deployment States**

| State | Meaning |
| --- | --- |
| `enabled` | Schedules fire per cron (nothing fires without a schedule) |
| `disabled` | The kill switch: schedules do not fire and manual runs are refused |
| `errored` | A scheduled dispatch failed on permissions; the scheduler stopped retrying. Fix access, then `enable()` or re-`deploy()` |
| `removed` | Soft-deleted: hidden from listings; history and artifacts survive. Re-`deploy()` any version to revive |

If a scheduled run is still in progress when the next tick comes due, that
tick is skipped — runs of the same deployment source never overlap.

## **Error Handling**

| Error | Cause |
| --- | --- |
| `RuntimeError` / `Error` | Unknown project/version; deploying an unpublished version; invalid cron; missing `teamId` |
| Permission error | Missing `task.control` on the TARGET team (mutations) or `task.monitor` (reads). Unknown and foreign teams are denied identically |

```python
try:
    await client.deploy.deploy('proj-1', 7, 'team-prod')
except RuntimeError as e:
    print(f'Deploy failed: {e}')
```

## **API Endpoints**

These methods communicate via the RocketRide DAP protocol over WebSocket
using the single `rrext_deploy` command, dispatched by a `subcommand`
argument:

| Method | DAP Command | `subcommand` |
| --- | --- | --- |
| `publish()` | `rrext_deploy` | `publish` |
| `deploy()` | `rrext_deploy` | `deploy` |
| `list()` | `rrext_deploy` | `list` |
| `get()` | `rrext_deploy` | `get` |
| `versions()` | `rrext_deploy` | `versions` |
| `history()` | `rrext_deploy` | `history` |
| `enable()` / `disable()` / `remove()` | `rrext_deploy` | `enable` / `disable` / `remove` |
| `pauseSchedule()` / `resumeSchedule()` | `rrext_deploy` | `schedule_pause` / `schedule_resume` |
| `setSchedule()` | `rrext_deploy` | `schedule_set` |
| `preview()` | `rrext_deploy` | `preview` |

## **Related Methods**

- [`use()`](./use) - Run a pipeline interactively in the current session
- [Run Log (`client.log`)](./log) - Watch and replay deploy runs (pass `teamId`)
- [`get_task_status()` / `getTaskStatus()`](./get-task-status) - Monitor a running pipeline
- [`terminate()`](./terminate) - Stop a running pipeline
