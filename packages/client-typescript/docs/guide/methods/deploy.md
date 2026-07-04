---
title: "Deploy"
date: 2026-06-12
---

- [Overview](#overview)
- [Methods](#methods)
- [Schedules](#schedules)
- [The DeploymentRecord](#the-deploymentrecord)
- [Usage Examples](#usage-examples)
- [Deployment States](#deployment-states)
- [Error Handling](#error-handling)
- [API Endpoints](#api-endpoints)
- [Related Methods](#related-methods)

## **Overview**

The `client.deploy` namespace manages **deployments**: pipelines persisted on the server and run on a cron schedule or on demand. Unlike `use()`, which runs a pipeline for the duration of your session, a deployment outlives the connection — the server starts scheduled runs on your behalf under the account that created the deployment.

Each deployment is identified by its pipeline's `project_id`. One deployment exists per project per user.

## **Methods**

| Method | Description |
| --- | --- |
| `deploy.add(pipeline, options?)` | Persist a pipeline as a deployment and activate it |
| `deploy.remove(projectId)` | Undeploy and delete the deployment |
| `deploy.list()` | List the authenticated user's deployments |
| `deploy.status(projectId)` | Get one deployment record |
| `deploy.update(projectId, options?)` | Replace the pipeline and/or schedule |

### Python (async)

```python
record = await client.deploy.add(pipeline, schedule='*/15 * * * *')
records = await client.deploy.list()
record = await client.deploy.status(project_id)
await client.deploy.update(project_id, schedule='@hourly')
await client.deploy.remove(project_id)
```

### TypeScript

```typescript
const record = await client.deploy.add(pipeline, { schedule: '*/15 * * * *' });
const records = await client.deploy.list();
const rec = await client.deploy.status(projectId);
await client.deploy.update(projectId, { schedule: '@hourly' });
await client.deploy.remove(projectId);
```

## **Schedules**

The `schedule` value accepted by `add()` and `update()`:

| Value | Meaning |
| --- | --- |
| `"manual"` | No scheduled runs; the deployment only runs when started explicitly. Default. |
| 5-field cron expression | e.g. `"*/15 * * * *"` — run every 15 minutes |
| Cron preset | `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly`, `@annually` |

Invalid schedule strings are rejected with an error.

## **The DeploymentRecord**

Returned by `add()`, `status()`, and (as an array) `list()`:

| Field | Type | Description |
| --- | --- | --- |
| `pipeline` | `PipelineConfig` | The deployed pipeline definition |
| `schedule` | `str` / `string` | Cron expression or `"manual"` |
| `state` | `string` | `"active"` \| `"paused"` \| `"errored"` (see [Deployment States](#deployment-states)) |
| `userId` | `str` / `string` | ID of the user who created the deployment |
| `createdAt` | `float` / `number` | Creation time (Unix seconds) |
| `updatedAt` | `float` / `number` | Last modification time (Unix seconds) |

## **Usage Examples**

### Deploy a pipeline on a 15-minute schedule

```python
import asyncio
from rocketride import RocketRideClient

async def main():
    async with RocketRideClient(uri="https://cloud.rocketride.ai", auth="my-key") as client:
        record = await client.deploy.add(my_pipeline, schedule="*/15 * * * *")
        print(record["pipeline"]["project_id"], record["state"])

asyncio.run(main())
```

```typescript
const client = new RocketRideClient({ uri: 'https://cloud.rocketride.ai', auth: 'my-key' });
await client.connect();

const record = await client.deploy.add(myPipeline, { schedule: '*/15 * * * *' });
console.log(record.pipeline!.project_id, record.state);
```

### Pause scheduled runs without deleting

Switch the schedule to `"manual"`; switch back to a cron expression to resume:

```python
await client.deploy.update(project_id, schedule="manual")
```

### Inspect and clean up

```python
for rec in await client.deploy.list():
    print(rec["pipeline"]["project_id"], rec["schedule"], rec["state"])

await client.deploy.remove(project_id)
```

## **Deployment States**

| State | Meaning |
| --- | --- |
| `active` | Scheduled runs fire per the cron schedule (no runs when schedule is `"manual"`) |
| `paused` | Deployment is retained but scheduled runs do not fire |
| `errored` | Scheduled runs could no longer authenticate (e.g. the owner's API key was revoked) and have stopped |

An `errored` deployment is not retried. Remove it and `add()` it again to resume scheduled runs.

If a scheduled run is still in progress when the next tick comes due, that tick is skipped — runs of the same deployment never overlap.

## **Error Handling**

| Error | Cause |
| --- | --- |
| `RuntimeError` / `Error` | Duplicate `add()` for an existing `project_id`; unknown `projectId` on `status()` / `update()` / `remove()`; invalid schedule string |
| Authentication error | Invalid or missing API key, or missing `task.control` permission |

```python
try:
    await client.deploy.add(pipeline, schedule="*/15 * * * *")
except RuntimeError as e:
    print(f"Deploy failed: {e}")
```

## **API Endpoints**

These methods communicate via the RocketRide DAP protocol over WebSocket using the `rrext_deploy_*` commands:

| Method | DAP Command |
| --- | --- |
| `add()` | `rrext_deploy_add` |
| `remove()` | `rrext_deploy_remove` |
| `list()` | `rrext_deploy_list` |
| `status()` | `rrext_deploy_status` |
| `update()` | `rrext_deploy_update` |

## **Related Methods**

- [`use()`](./use) - Run a pipeline interactively in the current session
- [`get_task_status()` / `getTaskStatus()`](./get-task-status) - Monitor a running pipeline
- [`terminate()`](./terminate) - Stop a running pipeline
