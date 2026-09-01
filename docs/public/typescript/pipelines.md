---
title: Running Pipelines
sidebar_position: 3
---

# Running Pipelines

Start a pipeline, watch its progress, and stop it. Method tables live in the
[API reference](/clients/typescript/reference#pipeline-execution); this page covers
the workflow.

## Start with `use()`

`use()` starts a pipeline from a file (Node only) or an in-memory config and
resolves to an object whose `token` identifies the running task — every data and
control call takes it.

```typescript
const { token } = await client.use({ filepath: './pipeline.pipe', ttl: 3600 });
```

Beyond `filepath`/`pipeline`, the options accept `source`, `threads`,
`useExisting`, `args`, `ttl`, `pipelineTraceLevel` (trace verbosity for the
[run log](/clients/typescript/logs)), `name` (a display name for the task), and
`env` (per-run variable overrides). Pass the pipeline config **as-is** — do not
wrap it in `{ pipeline: ... }`; the client sends it to the server, which resolves
`${ROCKETRIDE_*}` variables.

**Why a token:** the server runs each pipeline as a separate task. The token
targets `send()`, `sendFiles()`, `pipe()`, `chat()`, `getTaskStatus()`, and
`terminate()` at the correct pipeline.

## Watch progress

Poll `getTaskStatus(token)` — it returns `completedCount`, `totalCount`,
`completed`, `state`, `exitCode`, and more. A per-call
`{ timeout }` option defaults to 15000 ms; pass `false` to disable the bound:

```typescript
while (true) {
	const status = await client.getTaskStatus(token);
	console.log(`Progress: ${status.completedCount}/${status.totalCount}`);
	if (status.completed) break;
	await new Promise((r) => setTimeout(r, 2000));
}
```

### Events

For push-style progress instead of polling, add a monitor subscription; events
arrive at your [`onEvent` callback](/clients/typescript/configuration#callbacks):

```typescript
await client.addMonitor({ token }, ['apaevt_status_upload', 'apaevt_status_processing']);
// ... later:
await client.removeMonitor({ token }, ['apaevt_status_upload', 'apaevt_status_processing']);
```

`addMonitor(key, types)` / `removeMonitor(key, types)` are reference-counted —
adding the same key merges types, removing unsubscribes a type only when its count
reaches zero. The `MonitorKey` is `{ token }` for a running task, or
`{ projectId, source, pipeId?, teamId? }` (a team ID addresses that team's deployed
run). The older `setEvents(token, eventTypes, pipeId?)` still works but is
deprecated in favor of the monitor pair.

## Validate before you run

`validate({ pipeline, source? })` checks a pipeline config server-side without
starting it and returns errors and warnings — cheap insurance before `use()`.

## Stop with `terminate()`

`terminate(token)` stops the pipeline and frees server resources. Long-lived tasks
without a `ttl` run until terminated.

## Discover services

`getServices()` returns lightweight **summaries** of every service the server
supports (plus a deduplicated icon table and the server version). For a full
definition — config schema included — fetch one by name with `getService(name)`,
which returns a `ServiceDefinition` and **throws** on failure (it never resolves to
`undefined`).

```typescript
const services = await client.getServices();
const ocr = await client.getService('ocr'); // throws if unknown
```

## Liveness

`ping(token?)` performs a liveness check and throws on failure; the optional token
scopes the ping to a task.

> Deploying a pipeline so it persists server-side and runs on a schedule is a
> separate surface — see [Deployments](/clients/typescript/deploy).
