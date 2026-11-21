# memory_persistent

A RocketRide filter node that carries session memory across pipeline work by
`session_id`. Pick it when downstream nodes need prior session state; use
`memory_internal` for temporary, instance-scoped agent scratch space.

## About Redis

Redis is an optional backend this node uses for session values, metadata, and
operation history. Select it when memory must outlive the Python process; the
default backend keeps the same data in the node's state, which the server holds.

## What it does

On the `questions` lane, the node resumes or creates the session named in
question metadata and attaches its stored values as `memory_context` before
forwarding the question. On the `answers` lane, it writes the answer text to
`last_answer`, increments `answer_count`, and forwards the answer unchanged.
Choose it over `memory_internal` when this lane-based session context, a Redis
backend, or configurable expiry is needed.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `questions` | `questions` | Attach non-empty session context from memory, then forward the question. |
| `answers` | `answers` | Store the answer for its session, then forward it. |

## Profiles

Default: `memory` (**In-Memory (testing)**), which keeps the sessions in the
node's state.

| Profile | Backend | Session lifetime |
| --- | --- | --- |
| `memory` *(default)* | The node's state | Up to seven days after the last write. |
| `redis` | Redis at `localhost:6379` | 24 hours. |

Start with `memory`, then select `redis` when fifteen sessions per owner are
not enough; change its host and port to reach a Redis instance other than
the default `localhost:6379`.

## Configuration

Choose a backend first. The default keeps sessions in the node's state, which
the server stores per owner, so any engine replica serves the next call; it
holds at most 15 sessions per owner and keeps a session at most seven days after
its last write. A Redis deployment needs its connection values and a retention
policy. The history cap, auto-summarization and session TTL are per-call
parameters. The generated schema below is the complete field reference.

### Backend

`backend` accepts `memory` or `redis` and defaults to `memory`. The memory
backend keeps each session as one value of the node's state, plus one index
of the sessions: a node holds at most 16 state keys, so it keeps at most 15
sessions per owner, and the server, not the engine process, holds them.
Switch to `redis` for more sessions or for a retention policy of your own.

### Redis connection

`redis_host`, `redis_port`, and `redis_password` are used only with the Redis
backend. The Redis profile uses `localhost` and port `6379`; change the host
and port to reach a deployed server. A non-empty password is passed to the
Redis client, while an empty password becomes no password. Keep the memory
backend selected when no reachable Redis service is available.

### Session TTL (hours)

`session_ttl_hours` controls the TTL assigned when a new session is created.
The default `0` means no expiry; a value greater than zero expires all data,
keys, history, and metadata for that session together. Set a positive value
when stale context should be discarded automatically. With the state backend
no value outlives the state store's seven-day ceiling: a session record is
written with its remaining TTL, and a session with no TTL (or a longer one)
lives seven days, less an hour, after its last write; the index of sessions
is rewritten before any record could outlive it. Redis aligns the backend
keys with the session metadata TTL.

### History retention

Each stored value, counter increment, and clear operation records an operation
entry rather than the value itself. `max_history` defaults to `100`. When
`auto_summarize` is on (the default), the node checks after successful writes
and increments; if history exceeds that limit, it keeps the newest half and
replaces the older entries with one summary containing operation counts and
touched keys. Raise the limit to keep more recent operation detail; lower it
to bound history earlier. A clear is recorded but does not itself trigger the
summarization check.

## Authentication

For the Redis backend, provide `redis_password` only when the target Redis
server requires a password. The node passes that non-empty value directly to
the Redis client; the source does not configure any additional authentication
mechanism.

## Notes

### Session handling

A question or answer without a truthy metadata `session_id` passes through
without session storage, except that an answer can reuse the session ID seen on
the current question. Missing sessions are created on first use. Session IDs
must be 1–128 ASCII alphanumeric characters, hyphens, or underscores; keys
must be 1–256 characters from that set plus dots. Invalid session IDs are
logged and the affected question or answer is forwarded unchanged.

When a session has values, `questions` attaches every stored key and value as
`metadata['memory_context']`; an empty session adds no context. Answers use
`getText()` when available, otherwise their string representation, before
storing it as `last_answer`. Counter updates are lock-protected in memory and
use Redis `INCRBY` with the Redis backend.

### Backend behavior

Both backends return deep copies for stored values and history entries. Redis
serializes stored values as JSON under the `rr:memory` key prefix, and the
state backend stores JSON in the node's state. The Redis connection is opened
once per control and closed when the control ends.

## Upstream docs

- [Redis documentation](https://redis.io/docs/latest/)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `auto_summarize` | `boolean` | **Auto-Summarize**<br/>Automatically summarize older history entries when limit is reached | `true` |
| `backend` | `string` | **Backend**<br/>Storage backend: redis (production) or memory (testing) | `"memory"` |
| `max_history` | `number` | **Max History Entries**<br/>Maximum history entries per session before auto-summarization | `100` |
| `redis_host` | `string` | **Redis Host**<br/>Redis server hostname | `"localhost"` |
| `redis_password` | `string` | **Redis Password**<br/>Redis server password (leave empty for no auth) |  |
| `redis_port` | `number` | **Redis Port**<br/>Redis server port | `6379` |
| `session_ttl_hours` | `number` | **Session TTL (hours)**<br/>How long sessions persist before auto-expiry (0 = no expiry) | `0` |

## Dependencies

- `redis`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/memory_persistent)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
