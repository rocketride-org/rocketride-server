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
<!-- ROCKETRIDE:GENERATED:PARAMS END -->

## Scope

Deferred (see issue #1733): `context(id)` assembly, `kv` get/set/delete, `fork(id)` copy-on-write
state. Out of scope by architect decision: the streaming-transport surface (`log`/`topic`,
`views`, `graph`, `watch`, `fabric`) — RocketRide's engine is request-driven, and LaserData is
integrated here as a memory/state provider, not an event source.
