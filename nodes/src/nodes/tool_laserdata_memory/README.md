# LaserData Memory node

Adds durable, shared memory to agents through four tools: `laserdata.remember`,
`laserdata.recall`, `laserdata.improve`, and `laserdata.forget`.

This is a `tool` node (`classType: ["tool"]`, invoke capability, no data lanes). Multiple agents
can connect to the same LaserData Memory node and share its namespace-scoped durable memory.

## What it does

[LaserData](https://laserdata.com) is real-time data infrastructure on Apache Iggy: durable event
streams with memory/context/state SDKs on top. This node wraps the Laser SDK's `memory` primitive.
Every `remember` appends to a durable memory topic (an auditable event stream), `recall` folds the
topic back into the current items, `improve` records a ranking feedback signal, and `forget`
appends a tombstone. Memory survives pipeline restarts and is shared by every agent pointing at
the same deployment and namespace.

Memory is grouped by **namespace** (e.g. `customer:42`). By default the agent may pass a
namespace per call, falling back to the one configured on the node; turn
`allow_namespace_override` off to lock all calls to the configured namespace. A `conversation` id
can additionally scope items to one session.

## Tools

- **`laserdata.remember`** stores a statement verbatim and returns its `memory_id` (a
  time-ordered ULID).
- **`laserdata.recall`** returns up to `limit` items, most recent first. The topic-backed memory
  ignores the semantic `query` (a vector backend would rank by it); each row carries `id`,
  `text`, and — when present — `score`, `conversation`, and `kind`.
- **`laserdata.improve`** records feedback on an item: positive `weight` promotes it in future
  recalls, negative demotes it.
- **`laserdata.forget`** deletes one item by id (the durable audit stream keeps its history).

Bad input raises `ValueError`; backend and timeout failures raise `RuntimeError`. There is no
destructive clear/reset tool.

## SDK contract provenance

Built against **`laser-sdk==0.0.1rc21`** (PyPI, pinned in `requirements.txt`). rc20+ speaks only
Apache Iggy's VSR cluster protocol (the upcoming clustering wire format), so the server must be a
VSR-enabled build: LaserData Cloud deployments **created on/after 2026-07-31** serve it (older
deployments must be recreated — confirmed with the LaserData team), as does
[laserdata/laser-stack](https://github.com/laserdata/laser-stack) locally. The full
remember → recall → improve → forget round-trip was verified live against a LaserData Cloud
free-tier deployment on rc21/VSR (2026-07-31), including TLS auto-attach with the SDK's embedded
root CA. The SDK surface itself was verified by
introspection on 2026-07-29: `Laser.connect(connection_string)`, `laser.memory(namespace)`, and
async `Memory.remember/recall/improve/forget`. The SDK is a native (PyO3) async client whose
futures must be created on a running event loop, so the node keeps one persistent bridge loop in
a daemon thread (`IGlobal`) and submits each synchronously-dispatched tool call to it. The
connection opens lazily on the first tool call and closes on pipe teardown.

## Setup

The **LaserData deployment** dropdown selects a connection mode (a preconfig profile, same
pattern as the Qdrant node) and switches the visible fields and defaults:

**Your own Apache Iggy server** (`local`, the default):

- `connection_string`: `user:password@host:port`, e.g. `iggy:iggy@localhost:8090` (Iggy's
  default dev credentials). Secure field; falls back to the `LASER_CONNECTION_STRING`
  environment variable. A containerized engine needs an address reachable from the container
  (e.g. `host.docker.internal`). No token exists in this mode.
- The server must be a **VSR-enabled** Iggy build (rc20+ wheels speak only the VSR clustering
  protocol): use [laserdata/laser-stack](https://github.com/laserdata/laser-stack)
  (`./scripts/up`, which also prints a ready `LASER_CONNECTION_STRING`). Stock pre-VSR
  `iggyrs/iggy` images cannot talk to this SDK.
- `folded` defaults to `true` — recall folds the memory topic in-process, which a plain Iggy
  server (no managed backend) requires.

**LaserData Cloud** (`cloud`):

- `connection_string`: `user:password@<deployment-domain>:8090` — the user/password from the
  deployment's **Credentials** tab, the domain and TCP port from its **Overview** tab (secure;
  same env fallback). TLS is automatic for `*.laserdata.cloud` hosts (the SDK ships LaserData's
  root CA — no certificate file, no extra flags). There is no separate API token — all auth
  travels in the connection string. The deployment must serve VSR: created on/after 2026-07-31;
  recreate older ones (all verified against a live Cloud deployment).
- `folded` defaults to `true` — the folded (in-process) recall path is the one verified live
  against Cloud; turn it off only on a deployment serving a managed KV view.

Shared by both modes:

- `namespace`: default memory scope for all connected agents; required here or per call.
- `stream` (advanced): the Iggy stream the memory topics live in, pinned as the connection's
  default stream at connect. Defaults to `rocketride-memory`; nodes sharing one memory must match.
- `allow_namespace_override` (advanced): permit per-call namespaces. Defaults to `true`.
- `folded` (advanced): overridable per the mode notes above.
- `recall_limit` (advanced): default recall result limit, 1–200. Defaults to 10.
- `op_timeout` (advanced): per-operation timeout (including first connect), 5–600 seconds.
  Defaults to 30.

## Upstream docs

- LaserData: https://laserdata.com
- LaserData docs: https://docs.laserdata.com
- Laser SDK repo: https://github.com/laserdata/laser-sdk

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `laserdata.allow_namespace_override` | `boolean` | **Allow namespace override**<br/>When on (default), the agent may pass a different namespace per call. Turn off to lock every call to the configured namespace. | `true` |
| `laserdata.cloud.connection_string` | `string` | **Connection string**<br/>LaserData Cloud endpoint in the form <code>user:password@host:port</code> — the user and password from your deployment's <b>Credentials</b> tab, the domain and TCP port from its <b>Overview</b> tab. TLS is automatic for <code>*.laserdata.cloud</code> hosts (the SDK ships the LaserData root CA). The deployment must serve VSR — created on/after 2026-07-31; recreate older ones. Falls back to the LASER_CONNECTION_STRING environment variable when blank. | `""` |
| `laserdata.folded` | `boolean` | **Folded recall**<br/>When on (default), 'recall' folds the durable memory topic in-process — works against plain Apache Iggy and LaserData Cloud alike (verified live). Turn off only to read a managed KV view on a deployment that serves one. | `true` |
| `laserdata.local.connection_string` | `string` | **Connection string**<br/>Apache Iggy connection string in the form <code>user:password@host:port</code>, e.g. <code>iggy:iggy@localhost:8090</code>. The server must be a VSR-enabled Iggy build — use <a href='https://github.com/laserdata/laser-stack' target='_blank'>laser-stack</a> (its <code>./scripts/up</code> prints a ready connection string); stock pre-VSR Iggy images cannot talk to this SDK. A containerized engine needs an address reachable from the container, e.g. <code>host.docker.internal</code>. Falls back to the LASER_CONNECTION_STRING environment variable when blank. | `""` |
| `laserdata.namespace` | `string` | **Namespace**<br/>Memory scope every call reads and writes, e.g. <code>customer:42</code>. The agent can pass a namespace per call; one is required either on the call or here. | `""` |
| `laserdata.op_timeout` | `integer` | **Operation timeout (s)**<br/>Max seconds any single memory operation (including the first connect) may take before it fails. | `30` |
| `laserdata.profile` | `string` | **LaserData deployment**<br/>Connect to... | `"local"` |
| `laserdata.recall_limit` | `integer` | **Recall limit**<br/>Maximum number of memory items to retrieve per recall. | `10` |
| `laserdata.show_advanced` | `boolean` | **Advanced settings**<br/>Show advanced options. The defaults work for most cases, leave off for a simple setup. | `false` |
| `laserdata.stream` | `string` | **Stream**<br/>The Iggy stream the memory topics live in, pinned as the connection's default stream. All nodes sharing one memory must use the same stream. | `"rocketride-memory"` |

## Dependencies

- `laser-sdk` `==0.0.1rc21`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_laserdata_memory)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->

## Scope

Deferred (see issue #1733): `context(id)` assembly, `kv` get/set/delete, `fork(id)` copy-on-write
state. Out of scope by architect decision: the streaming-transport surface (`log`/`topic`,
`views`, `graph`, `watch`, `fabric`) — RocketRide's engine is request-driven, and LaserData is
integrated here as a memory/state provider, not an event source.
