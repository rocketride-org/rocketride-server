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

Built against **`laser-sdk==0.0.1rc20`** (PyPI, pinned in `requirements.txt`), verified by
introspection on 2026-07-29: `Laser.connect(connection_string)`, `laser.memory(namespace)`, and
async `Memory.remember/recall/improve/forget`. The SDK is a native (PyO3) async client whose
futures must be created on a running event loop, so the node keeps one persistent bridge loop in
a daemon thread (`IGlobal`) and submits each synchronously-dispatched tool call to it. The
connection opens lazily on the first tool call and closes on pipe teardown.

## Setup

Configure these node settings:

- `connection_string`: `user:password@host:port`, e.g. `iggy:laser@localhost:8090` for a local
  Apache Iggy server. Secure field; falls back to the `LASER_CONNECTION_STRING` environment
  variable. A containerized engine needs an address reachable from the container
  (e.g. `host.docker.internal`).
- `token`: optional LaserData Cloud token (secure; falls back to `LASER_TOKEN`). Not needed for
  plain self-hosted Iggy.
- `namespace`: default memory scope for all connected agents; required here or per call.
- `allow_namespace_override`: permit per-call namespaces. Defaults to `true`.
- `folded`: fold the memory topic in-process on recall (works against plain Apache Iggy).
  Defaults to `true`; turn off to read a managed KV view on LaserData Cloud.
- `recall_limit`: default recall result limit, 1–200. Defaults to 10.
- `op_timeout`: per-operation timeout (including first connect), 5–600 seconds. Defaults to 30.

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
