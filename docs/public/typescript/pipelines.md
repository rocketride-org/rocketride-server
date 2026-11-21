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
resolves to an object whose `token` field carries the **control id** — every
data and control call takes it. The task's **address** rides beside it as
`address`.

```typescript
const { token, address } = await client.use({ filepath: './pipeline.pipe', ttl: 3600 });
// token === '=control/1234abcd1234abcd1234abcd1234abcd'   (the control id)
// address === 'acme.docBrain.chat_1'                       (the address)
```

The control id is an opaque, transient handle: the server mints it when it creates
the control, it is valid for the life of that control, and it dies with it — a
`terminate()` ends it and a `restart()` mints a new one. Never persist it (not in
storage, not in a URL); hold it in memory and recover it with `getTaskToken()`
after a reload. The address is `developerId.pipelineId[.source]`: your
organization's developer id, the pipe's `project_id`, and the source component,
each a single dot-free segment. The server derives it; it is a name, not a secret,
and it is the stable identity you log, share and resolve by. Authority comes from
the account on the request: every call carries your `rr_` API key (or your
session), and the server checks on every call that this account owns the control
it names (a control id you do not own is `permission_denied`).

Beyond `filepath`/`pipeline`, the options accept `source`, `threads`,
`useExisting`, `args`, `ttl`, `pipelineTraceLevel` (trace verbosity for the
[run log](/clients/typescript/logs)), `name` (a display name for the task), and
`env` (per-run variable overrides), and `token`, which overrides the pipeline-id
segment of the address (the pipeline's `project_id`). Pass the pipeline config
**as-is** — do not wrap it in `{ pipeline: ... }`; the client sends it to the
server, which resolves `${ROCKETRIDE_*}` variables. The config's `project_id` is
**required**: a spec without one is refused with `invalid_argument` naming the
field.

**One control per spec.** The server keys your control by `project_id` and the
resolved configuration. A second `use()` of the same spec while the first is live
resolves to the same control id; a spec whose configuration differs under the same
`project_id` is a new control (on the same engine), and the earlier one lives until
you stop it or its idle ttl ends. To run two copies of one spec at once, give the
copy its own pipeline id: either a different `project_id` in the config, or `token`,
which does the same without editing the config:

```typescript
const { address } = await client.use({ filepath: './pipeline.pipe', token: 'runB' });
// address === 'acme.runB.chat_1'
```

The value is one address segment (letters, digits, `_` and `-`); anything else
is refused the way an invalid `project_id` is. It is a name inside your own
namespace, not a credential: the developer id and the owner still come from your
account, and the returned `token` is the control id as always. Terminate a run you
started this way when you are done with it.
`getTaskToken({ projectId, source })` returns the control id of your running task
for that pipe and source (pass `teamId` for the team's deployed run). After an
override the run's pipeline id is the `token` value, so look it up with
`projectId: 'runB'`; the config's original `project_id` finds the run started
without an override, if any.

**Check `reused` before trusting the result.** `useExisting` attaches to the
control already live for that `project_id` whatever its configuration, rather than
resolving the one you submitted, and the result's `reused` flag is `true` when that
happened. A reused control keeps the configuration it was created with — the
pipeline in this call is ignored, edits included — along with whatever state it has
accumulated. Benchmarks and A/B comparisons are where an unnoticed reuse costs the
most. Call `restart()` to apply new configuration to a running task; it terminates
the control and creates a new one, so read the new control id with
`getTaskToken()` before sending again.

**Why a control id:** the server runs each control on an engine shared by every
pipeline of the same shape. The control id targets `send()`, `sendFiles()`,
`pipe()`, `chat()`, `getTaskStatus()`, and `terminate()` at your control, and
nothing else; the address is what names and resolves the pipe.

The data calls (`send()`, `sendFiles()`, `pipe()`, `chat()`) also take an
address in place of the control id. The open resolves it the way `submit()`
resolves a name, starting a published rung when nothing is live, and answers
with the control id that every later frame of the pipe names. This is how the
webhook door and the chat and dropper apps reach a pipe they know only by name.
The server tells the two apart by form: a control id always starts with
`=control/`, which no address can.

## Calls from other systems

A webhook caller (Stripe, GitHub, a CI job) authenticates the same way as the
SDK: with an `rr_` API key in the `Authorization` header, never in the URL. Post
to `/webhook/<address>` (or `/task/data/<address>`):

```bash
curl -X POST "https://your-server/webhook/acme.docBrain.parsePDF" \
  -H "Authorization: Bearer $ROCKETRIDE_APIKEY" \
  -F "file=@document.pdf"
```

For a key that lives in another system, create a **scoped** key on the owner's
account rather than handing over a full one: permissions `['task.data']` and
endpoints `['acme.docBrain.parsePDF']` (or `['acme.docBrain.*']` for every source
of that pipe). The key can then send data to that address and nothing else, and
the owner pays for its calls. A key scoped to exactly one exact address (not a
`.*` pattern) may post to the bare `/webhook`, since the key already names it. A connected client can
read its key's scope from `ConnectResult.endpoints`
([Connection](/clients/typescript/connection)).

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
definition — the resolved `properties` (every leaf with its stored `path`) and the
`params` descriptors included — fetch one by name with `getService(name)`, which
returns a `ServiceDefinition` and **throws** on failure (it never resolves to
`undefined`), or every service at once with `getServices({ definitions: true })`,
which returns a `ServiceDefinitionsResponse` (no icon table in that form).

```typescript
const services = await client.getServices();
const ocr = await client.getService('ocr'); // throws if unknown
const all = await client.getServices({ definitions: true });
```

## Liveness

`ping(token?)` performs a liveness check and throws on failure; the optional token
scopes the ping to a task.

> Deploying a pipeline so it persists server-side and runs on a schedule is a
> separate surface — see [Deployments](/clients/typescript/deploy).
