# memory_persistent

Gives your pipeline a memory that survives across runs, keyed by `session_id`.

## What it does

Unlike [memory_internal](../memory_internal/) — which is run-scoped, wired only to the Wave agent, and cleared at the end of each run — this node keeps session state between runs and sits in the pipeline as a pass-through filter on the `questions` and `answers` lanes.

When a question carries a `session_id` in its metadata, the node resumes (or creates) that session and attaches its stored keys to the question as memory context before forwarding. Answers for that session are saved back (e.g. `last_answer`, an `answer_count`) for later. Questions without a `session_id` pass through untouched.

You get session management, keyed storage, history tracking, and automatic summarization of older entries once the limit is hit.

**Lanes:**

| Lane in     | Lane out    | Description                                              |
| ----------- | ----------- | ------------------------------------------------------- |
| `questions` | `questions` | Enriched with session memory context in metadata        |
| `answers`   | `answers`   | Stored in session memory, then passed through           |

## Setup

The default `memory` backend is in-process and needs no setup (intended for testing). For production, select the `redis` backend and point it at a reachable Redis instance via the config fields below.

## Configuration

| Field             | Default     | Description                                                       |
| ----------------- | ----------- | ---------------------------------------------------------------- |
| Backend           | `memory`    | Storage backend: `redis` (production) or `memory` (testing).     |
| Redis Host        | `localhost` | Redis server hostname.                                           |
| Redis Port        | `6379`      | Redis server port.                                               |
| Redis Password    | *(empty)*   | Redis password (leave empty for no auth).                        |
| Session TTL (hours) | `0`       | How long sessions persist before auto-expiry (`0` = no expiry).  |
| Max History Entries | `100`     | History entries per session before auto-summarization.           |
| Auto-Summarize    | `true`      | Summarize older history entries when the limit is reached.       |
