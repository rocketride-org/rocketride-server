# tool_mem0

Long-term, shared agent memory exposed as **tools** (`mem0.remember` / `mem0.recall`),
backed by the hosted [Mem0 Platform](https://docs.mem0.ai) REST API.

This is a `tool` node (`classType: ["tool"]`, no data lanes), not the agent's run-scoped
`memory` subsystem, it complements it. Wire it to an agent via `control` (class `tool`).

## About Mem0

Mem0 is a memory platform for AI applications. It stores conversation-derived
facts and supports semantic retrieval, which makes it suitable when several
agents or pipeline runs need a shared memory outside a single run.

## What it does

This node gives an agent persistent, externally hosted memory through two
tools and has no data lanes. Pick it over an in-run memory component when a
fact must be available to later agents or pipeline executions that use the
same configured scope.

## As a tool

- **`mem0.remember`** → `POST /v1/memories/`: ingest conversation turns; Mem0 extracts and
  stores salient facts server-side.
- **`mem0.recall`** → `POST /v1/memories/search/`: semantic search over the pool; returns
  ranked memories.

## Configuration

`api_key` is required (or set `MEM0_API_KEY`); a scope is required to store and recall. The full
field set is in [`doc.md`](./doc.md) and `services.json`.

**Scope with `user_id`.** On the hosted platform a memory added with an `agent_id` / `app_id` is
stored under the `user_id` but doesn't reliably carry that id, while `recall` AND-narrows by every
id set, so configuring `agent_id` can make recalls come back empty even though the write
succeeded (verified against the live API). Use `user_id` (and `run_id` for sessions); leave
`agent_id` / `app_id` empty unless verified for your account.

### Ingestion and recall behavior

Leave **Infer memories** on to let Mem0 derive salient facts from supplied
turns; turn it off only when raw messages are the desired stored form. Keep
**Synchronous store** on when a following recall must see the just-added fact;
turning it off returns before background extraction completes. Increase the
store timeout only when extraction regularly outlives its 30-second default,
and adjust the recall limit when the agent needs a broader or narrower result
set.

## Notes

### Direct REST integration

This node calls the Mem0 REST API directly with `requests` rather than the `mem0ai` SDK: the
SDK hard-pins `openai<1.110`, which is unsatisfiable alongside the engine's OpenAI nodes
(`openai>=2.38`). The REST surface is identical: the entity ids
(`user_id` / `agent_id` / `run_id` / `app_id`) go top-level in the JSON body for both `add` and
`search`, built from one internal scope helper. Deps (`requests`, `tenacity`) are already in the
engine: no new third-party packages, no version conflict.

Mem0's `add` is asynchronous (queues extraction, returns an `event_id`). By default `remember`
polls `GET /v1/event/{event_id}/` until the job is terminal (or `ingest_timeout` elapses) so a
following `recall` sees the memory, like xTrace's synchronous ingest. Turn `wait` off for
fire-and-forget. `search` returns ranked rows (handled whether the API returns a bare list or a
`{"results": […]}` object).

### Credentials

Get an API key (`m0-…`) from [app.mem0.ai](https://app.mem0.ai) → API Keys. Never commit keys:
use node config (encrypted) or the env var.

## Upstream docs

- [Mem0 documentation](https://docs.mem0.ai)
