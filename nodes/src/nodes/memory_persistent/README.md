# memory_persistent

A RocketRide filter node that gives a pipeline cross-session memory keyed by `session_id`.

## What it does

Sits in the pipeline as a pass-through filter on the `questions` and `answers` lanes and keeps session state between pipeline runs.

When a question arrives with a `session_id` in its metadata, the node resumes (or creates) that session and attaches all stored keys to the question as `metadata['memory_context']` before forwarding, so downstream nodes such as LLMs can use prior conversation state. Answers for the same session are saved back: the answer text is stored under the key `last_answer` and an `answer_count` counter is incremented atomically. An answer without its own `session_id` falls back to the session of the question currently being processed. Questions and answers with no `session_id` pass through untouched.

Storage uses a pluggable backend: **Redis** (via the `redis` Python client, `>=6.4.0,<7.0.0`) for production, or a thread-safe **in-memory** backend for testing. The store is created once per pipe and the backend connection is closed when the pipe ends. The node is marked **experimental**. All operations deep-copy entries before enrichment so originals are never mutated.

---

## Configuration

### Lanes

| Lane in     | Lane out    | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `questions` | `questions` | Enriched with session memory context in metadata, then forwarded |
| `answers`   | `answers`   | Stored in session memory, then passed through                    |

### Fields

| Field | Type | Description |
|---|---|---|
| `backend` | string | Default "memory". Storage backend: redis (production) or memory (testing) |
| `redis_host` | string | Default "localhost". Redis server hostname |
| `redis_port` | number | Default 6379. Redis server port |
| `redis_password` | string | Redis server password (leave empty for no auth) |
| `session_ttl_hours` | number | Default 0. How long sessions persist before auto-expiry (0 = no expiry) |
| `max_history` | number | Default 100. Maximum history entries per session before auto-summarization |
| `auto_summarize` | boolean | Default true. Automatically summarize older history entries when limit is reached |

### Profiles

| Profile  | Behaviour                                                                           |
| -------- | ----------------------------------------------------------------------------------- |
| `memory` | **Default.** In-process backend, no setup needed; no TTL (`session_ttl_hours: 0`)  |
| `redis`  | Redis at `localhost:6379`, 24-hour session TTL                                      |
| `custom` | Redis backend with an empty host for you to fill in; no TTL                         |

The `memory` backend is in-process and intended for testing: its contents live only as long as the engine process. For production, select the `redis` backend and point it at a reachable Redis instance.

---

## Sessions

Sessions are identified by the `session_id` value in question or answer metadata. A valid `session_id` is 1-128 characters of alphanumerics, hyphens, or underscores; this is enforced to prevent injection into Redis key names. A malformed `session_id` does not fail the pipeline: the node logs a debug message and forwards the entry unchanged.

Memory keys (for example `last_answer`) follow the same character rules but also allow dots and may be up to 256 characters long.

- **TTL:** with `session_ttl_hours > 0`, every key belonging to a session expires together. In Redis this uses native key expiry kept aligned across data, key-set, history, and metadata keys. The in-memory backend prunes expired sessions lazily on access. A value of `0` means sessions never expire.
- **In-memory cap:** the in-memory backend holds at most 1000 concurrent sessions; creating more returns an error.
- **Atomic counters:** `answer_count` increments are atomic: native `INCRBY` in Redis, lock-protected in the in-memory backend.

---

## History and auto-summarization

Every `put`, `increment`, and `clear` appends an operation record (`op`, `key`, `timestamp`) to the session's history. History records operations, not values. When `auto_summarize` is `true` and a session's history grows beyond `max_history`, older entries are compressed: the newest `max_history // 2` entries are kept intact and everything older is replaced by a single summary entry recording how many entries were summarized, the counts per operation type, and which keys were touched.

---

## Redis key layout

All Redis keys live under the `rr:memory` prefix:

| Key                                    | Contents                         |
| -------------------------------------- | -------------------------------- |
| `rr:memory:{session_id}:{key}`         | Stored values (JSON-serialized)  |
| `rr:memory:{session_id}:__keys__`      | Set of keys in the session       |
| `rr:memory:{session_id}:__history__`   | List of history entries          |
| `rr:memory:{session_id}:__meta__`      | Hash with session metadata       |
| `rr:memory:__sessions__`               | Set of all session IDs           |

---

## Running the tests

```bash
# Store unit tests + node tests (in-memory backend, no Redis needed)
pytest nodes/test/memory_persistent -v
```

---

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
