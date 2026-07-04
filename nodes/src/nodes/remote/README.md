# remote

A RocketRide infrastructure node that forwards execution of a sub-pipeline to a separate RocketRide server.

## What it does

Forwards pipeline execution to a separate RocketRide server. The sub-pipeline
configuration is sent to the remote server over HTTP, data streams through a persistent
WebSocket connection, and results are returned to the local pipeline as they are
produced. Use this to run GPU-heavy or resource-intensive sub-pipelines on a dedicated
machine.

The node directory ships two services:

| Service | Protocol | Role |
|---------|----------|------|
| **Remote Processing** (`services.client.json`) | `remote://` | The node you place in a pipeline. Holds the sub-pipeline and the connection settings. |
| **Remote Server** (`services.server.json`) | `remote_server://` | Internal counterpart instantiated inside the remote pipeline. Marked `internal` -- never added by users directly. |

Built on **fastapi** (server-side WebSocket endpoint), **websockets** (synchronous
client connection), and **nest-asyncio** (running async coroutines from the synchronous
engine context).

Both services carry the `nosaas` capability -- the node is available on self-hosted
deployments only, not on RocketRide Cloud.

---

## How it works

`preparePipeline` (in `client/prepare_pipeline.py`) rewrites the user's simplified
pipeline before execution, based on the selected profile:

- **`local` profile** -- the remote node is removed and its sub-pipeline components are
  inlined into the local pipeline at the same position. Nothing leaves the machine.
- **`remote` profile** -- lanes that cross the local/remote boundary are rewired through
  the `remote` (client) and `remote_server` nodes, and a `remote_source_stub` source is
  inserted at the head of the remote pipeline:
  - local to remote: `local component -> remote -> remote_server -> remote component`
  - remote to local: `remote component -> remote_server -> remote -> local component`

Every component placed inside the sub-pipeline must support remote execution
(`PROTOCOL_CAPS.REMOTING`); preparation fails with
`The component '<provider>' does not support remote execution` otherwise. The remote
node itself must not have any `input` entries of its own in the simplified
configuration.

At runtime (remote profile) the client:

1. Sends `POST http://<host>:<port>/use?name=remote` to load the remote node on the server.
2. Creates the remote pipe with `POST http://<host>:<port>/remote?pipe=<taskId>`, posting the sub-pipeline JSON. The task ID of the running job identifies the pipe.
3. Opens `ws://<host>:<port>/remote/pipe?pipe=<taskId>` and keeps it open for the lifetime of the instance.
4. Deletes the remote pipe with `DELETE` on the same control URL when the pipeline ends.

All HTTP and WebSocket requests carry an `Authorization: Bearer <apikey>` header.

---

## Configuration

### Lanes

`services.client.json` declares no static lanes (`"lanes": {}`); lane wiring is derived
from the sub-pipeline by `preparePipeline`. At runtime the client forwards these calls
over the WebSocket when the lane is listed in `input`:

| Lane | Payload | Sent when |
|------|---------|-----------|
| `tags` | bytes | `writeTag` -- only if `tags` is in `input` (default) |
| `text` | string | `writeText` -- only if `text` is in `input` |
| `words` | string list | `writeWords` -- only if `words` is in `input` |
| `documents` | document list | `writeDocuments` -- only if `documents` is in `input` |

Lifecycle calls `open`, `closing`, and `close` are always forwarded so the remote
pipeline tracks the local object lifecycle. Responses from the remote pipeline
(`writeText`, `writeDocuments`, etc.) are dispatched back into the local pipeline as
they arrive.

### Fields

Settings live under the node's `remote` configuration block; the sub-pipeline lives
under `pipeline`.

| Field      | Type / default | Description |
|------------|----------------|-------------|
| `profile`  | enum, default `local` | Execution mode: `local` or `remote` (see profiles below). |
| `host`     | string | Hostname or IP of the remote RocketRide server. Required in remote mode. |
| `port`     | number | Server port. Required in remote mode (remote profile preset uses `5565`). |
| `apikey`   | string | Bearer token for authenticating against the remote server. Required in remote mode. |
| `pipeline` | object | The sub-pipeline definition to execute remotely. Required. |
| `input`    | string list, default `["tags"]` | Lanes forwarded from the local pipeline to the remote one. |
| `output`   | string list, default `["documents"]` | Lanes expected back from the remote pipeline. |

Startup fails fast with an explicit exception if `host`, `port`, `apikey`, `pipeline`,
or the job's task ID is missing.

---

## Profiles

| Profile | Description |
|---------|-------------|
| `local` _(default)_ | Runs the sub-pipeline on the same machine -- components are inlined, no network involved. |
| `remote` | Runs the sub-pipeline on a separate host. Preset values: `host: localhost`, `port: 5565`, `apikey: xxx` -- override all three before use. |

---

## Error handling and limits

- Every forwarded call is acknowledged: after processing, each side sends an `error`
  lane message containing an `APERR` result. A non-success code is re-raised on the
  caller's side, so remote failures surface in the local pipeline with the original
  error code (`Ec.RemoteException` wraps errors that originate locally while handling a
  remote response).
- List payloads are split into chunks whose estimated JSON size stays under ~0.98 MiB,
  keeping each WebSocket message below the default 1 MiB `max_size`. Large document
  batches therefore transfer as multiple messages transparently.
- The WebSocket is opened with no open/close timeout and stays connected for the whole
  instance lifetime; `websockets.client` logging is routed through the engine's
  `Remoting` log level.

---

## Notes

- Self-hosted deployments only -- not available on RocketRide Cloud (`nosaas` capability).
- The remote server must be running a RocketRide instance with the server component enabled.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

### Remote Processing (`services.client.json`)

_No configuration fields._

## Dependencies

- `fastapi`
- `nest-asyncio`
- `websockets`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/remote)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
