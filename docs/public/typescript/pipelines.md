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

Beyond `filepath`/`pipeline`, the options accept `token` (a custom task token;
the server generates one when omitted), `source`, `threads`,
`useExisting`, `args`, `ttl`, `pipelineTraceLevel` (trace verbosity for the
[run log](/clients/typescript/logs)), `name` (a display name for the task), and
`env` (per-run variable overrides). Pass the pipeline config **as-is** — do not
wrap it in `{ pipeline: ... }`; the client sends it to the server, which resolves
`${ROCKETRIDE_*}` variables.

**Running the same pipeline more than once at a time.** Without a custom `token`,
the server names the task after its owner, `project_id` and source, so a second
`use()` of the same pipe fails with `Pipeline is already running.` Give each
instance its own `token` and they run side by side:

```typescript
const { token } = await client.use({ filepath: './pipeline.pipe', token: `tk_${crypto.randomUUID()}` });
```

The value you choose is the run's
[private token](/operate/security#endpoint-authentication): full control of
the run for anyone who presents it. So make it unguessable, and keep the `tk_`
prefix (without it the token cannot authenticate on webhook or dropper
endpoints). Tokens share one namespace across every user of the server: a
predictable value collides with other people's tasks, and with `useExisting` a
token that matches a running task attaches to it, whoever started it.

What two instances still share:

- **The `pk_` public authorization key.** Both get the same one, and a webhook
  call or dropper upload that uses it always reaches the instance that started
  first. To send data to one specific instance, use that instance's `tk_` token.
- **`getTaskToken()`**, keyed by the pipe's `project_id` and source, returns only
  one of them.
- **The monitor subscription.** Both instances' events arrive in one
  subscription. Each event carries the emitting run's id in `body.__id` (the
  first eight characters of the token after `tk_`, plus the source id); it is
  truncated and can collide, so treat it as a best-effort way to tell them
  apart. A few minutes after one instance ends, when the server removes it
  from its registry, the shared subscription is dropped and the surviving
  instance's events stop arriving; resubscribe.
- **The run log**, written per identity and not built for two instances at
  once; treat a forked run's log as unreliable.

**Check `reused` before trusting the result.** `useExisting` returns the
instance that is already running under that token rather than starting the one
you submitted, and the result's `reused` flag is `true` when that happened. A
reused instance keeps the configuration it was created with — the pipeline in
this call is ignored, edits included — along with whatever state it has
accumulated. Benchmarks and A/B comparisons are where an unnoticed reuse costs
the most. Call `restart()` to apply new configuration to a live token.

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
