---
title: Running Pipelines
sidebar_position: 3
---

# Running Pipelines

Start a pipeline, watch its progress, and stop it. Method tables live in the
[API reference](/clients/python/reference#pipeline-execution); this page covers the
workflow.

## Start with `use()`

`use()` starts a pipeline from a file or an in-memory config and returns a dict whose
`'token'` carries the **control id** — every data and control call takes it. The
task's **address** rides beside it as `'address'`.

```python
result = await client.use(filepath='pipeline.pipe')
token = result['token']
# token == '=control/1234abcd1234abcd1234abcd1234abcd'   (the control id)
# result['address'] == 'acme.docBrain.chat_1'             (the address)
```

The control id is an opaque, transient handle: the server mints it when it creates
the control, it is valid for the life of that control, and it dies with it — a
`terminate()` ends it and a `restart()` mints a new one. Never persist it (not in a
file, a database or a URL); hold it in memory and recover it with
`get_task_token()` after a reload. The address is `developerId.pipelineId[.source]`:
your organization's developer id, the pipe's `project_id`, and the source
component, each a single dot-free segment. The server derives it; it is a name,
not a secret, and it is the stable identity you log, share and resolve by.
Authority comes from the account on the request: every call carries your `rr_`
API key (or your session), and the server checks on every call that this account
owns the control it names (a control id you do not own is `permission_denied`).

Beyond `filepath`/`pipeline`, `use()` accepts `source`, `threads`, `use_existing`,
`args`, `ttl`, `pipelineTraceLevel` (trace verbosity for the
[run log](/clients/python/logs)), `name` (a display name for the task), `env`
(per-run variable overrides), and `token`, which overrides the pipeline-id segment
of the address (the pipeline's `project_id`). Pass the pipeline config **as-is** —
the client sends it to the server, which resolves `${ROCKETRIDE_*}` variables from
its merged environment. The config's `project_id` is **required**: a spec without
one is refused with `invalid_argument` naming the field.

**One control per spec.** The server keys your control by `project_id` and the
resolved configuration. A second `use()` of the same spec while the first is live
returns the same control id; a spec whose configuration differs under the same
`project_id` is a new control (on the same engine), and the earlier one lives until
you stop it or its idle ttl ends. To run two copies of one spec at once, give the
copy its own pipeline id: either a different `project_id` in the config, or `token`,
which does the same without editing the config:

```python
result = await client.use(filepath='pipeline.pipe', token='runB')
# result['address'] == 'acme.runB.chat_1'
```

The value is one address segment (letters, digits, `_` and `-`); anything else
is refused the way an invalid `project_id` is. It is a name inside your own
namespace, not a credential: the developer id and the owner still come from your
account, and the returned `token` is the control id as always. Terminate a run you
started this way when you are done with it. `get_task_token()` returns the
control id of your running task for a pipe and source (pass `team_id` for the
team's deployed run). After an override the run's pipeline id is the `token`
value, so look it up with `project_id='runB'`; the config's original
`project_id` finds the run started without an override, if any.

**Check `reused` before trusting the result.** `use_existing` attaches to the
control already live for that `project_id` whatever its configuration, rather than
resolving the one you submitted, and the result's `reused` flag is `True` when that
happened. A reused control keeps the configuration it was created with — the
pipeline in this call is ignored, edits included — along with whatever state it has
accumulated. Benchmarks and A/B comparisons are where an unnoticed reuse costs the
most. Call `restart()` to apply new configuration to a running task; it terminates
the control and creates a new one, so read the new control id with
`get_task_token()` before sending again.

**Why a control id:** the server runs each control on an engine shared by every
pipeline of the same shape. The control id targets `send()`, `send_files()`,
`pipe()`, `chat()`, `get_task_status()`, and `terminate()` at your control, and
nothing else; the address is what names and resolves the pipe.

The data calls (`send()`, `send_files()`, `pipe()`, `chat()`) also take an
address in place of the control id. The open resolves it the way `submit()`
resolves a name, starting a published rung when nothing is live, and answers
with the control id that every later frame of the pipe names. This is how the
webhook door and the chat and dropper apps reach a pipe they know only by name.
The server tells the two apart by form: a control id always starts with
`=control/`, which no address can.

## Watch progress

Poll `get_task_status(token)` — it returns `completedCount`, `totalCount`,
`completed`, `state`, `exitCode`, and more:

```python
while True:
    status = await client.get_task_status(token)
    print(f'Progress: {status.get("completedCount", 0)}/{status.get("totalCount", 0)}')
    if status.get('completed'):
        break
    await asyncio.sleep(2)
```

### Events

For push-style progress instead of polling, add a monitor subscription; events
arrive at your [`on_event` callback](/clients/python/configuration#callbacks):

```python
await client.add_monitor({'token': token}, ['apaevt_status_upload', 'apaevt_status_processing'])
# ... later:
await client.remove_monitor({'token': token}, ['apaevt_status_upload', 'apaevt_status_processing'])
```

`add_monitor(key, types)` / `remove_monitor(key, types)` are reference-counted —
adding the same key merges types, removing unsubscribes a type only when its count
reaches zero. The key is `{'token': ...}` for a running task, or
`{'project_id': ..., 'source': ...}` (optionally with `'pipe_id'` and/or
`'team_id'` — a team ID addresses that team's deployed run). The older
`set_events(token, event_types, pipe_id=None)` still works but is deprecated in
favor of the monitor pair.

## Validate before you run

`validate(pipeline, source=None)` checks a pipeline config server-side without
starting it and returns errors and warnings — cheap insurance before `use()`.

## Stop with `terminate()`

`terminate(token)` stops the pipeline and frees server resources. Long-lived tasks
without a `ttl` run until terminated.

## Discover services

`get_services()` returns lightweight **summaries** of every service the server
supports (plus a deduplicated icon table and the server version). For a full
definition — config schema included — fetch one by name with `get_service(name)`.
Note `get_service` **raises** on failure (`ValueError` for an empty name,
`RuntimeError` for an unknown service); it never returns `None`.

```python
services = await client.get_services()
ocr = await client.get_service('ocr')  # raises if unknown
```

## Liveness

`ping()` performs a liveness check against the server and raises on failure.

> Deploying a pipeline so it persists server-side and runs on a schedule is a
> separate surface — see [Deployments](/clients/python/deploy).
