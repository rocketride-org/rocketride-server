# Cognee node

Turns content into a queryable AI-memory knowledge graph, exposed as **tools**
(`cognee.add` / `cognee.cognify` / `cognee.search` / `cognee.reset`), backed by a
[cognee](https://docs.cognee.ai) server.

This is a `tool` node (`classType: ["tool"]`, no data lanes), not the agent's run-scoped
`memory` subsystem — it complements it with external, persistent memory. Wire it to an agent via
`control` (class `tool`).

## What it does

Cognee ingests content, builds a knowledge graph plus embeddings from it, and answers
natural-language questions over that memory. The usual agent flow is **add → cognify → search**:
`add` stores raw content, `cognify` builds the graph (this is the step that calls an LLM), and
`search` retrieves. Memory is grouped into **datasets**; every tool defaults to the configured
dataset and the agent can override it per call. All tools talk to cognee's REST API and raise on
error.

## Tools

- **`cognee.add`** → `POST /api/v1/add`: ingest content (raw text, or a URL / public repo URL for
  cognee to fetch) into a dataset. Storing only — it does not build the graph.
- **`cognee.cognify`** → `POST /api/v1/cognify`: build the knowledge graph + embeddings from
  added data. Run after `add` and before `search`. **Synchronous by default** and can take
  minutes on large datasets; set `run_in_background` to return immediately with a run id.
- **`cognee.search`** → `POST /api/v1/search`: answer a query from memory. `search_type` selects
  the strategy — `GRAPH_COMPLETION` (default), `RAG_COMPLETION`, `CHUNKS`, `SUMMARIES`,
  `TEMPORAL`, `FEELING_LUCKY`. Returns ranked results and their count.
- **`cognee.reset`** → `GET` + `DELETE /api/v1/datasets/{id}`: permanently clear a dataset (graph,
  data, and the dataset record). Reports `not_found` when the dataset does not exist.

## Setup

Point `base_url` at your cognee server:

- **Self-hosted** (the default): run cognee with Docker; the REST API listens on
  `http://localhost:8000`. If the engine runs in a container, use `http://host.docker.internal:8000`.
- **Cognee Cloud**: use your instance URL from [platform.cognee.ai](https://platform.cognee.ai).

**API key is optional.** cognee sends it as the `X-Api-Key` header. A self-hosted server with
access control disabled (`ENABLE_BACKEND_ACCESS_CONTROL=false`) accepts unauthenticated calls, so
you can leave the key blank; Cognee Cloud and multi-tenant deployments require one. The key falls
back to the `COGNEE_API_KEY` env var. Never commit keys — use node config (encrypted) or the env
var.

Cognee needs an LLM key of its own (e.g. `LLM_API_KEY`) configured **on the cognee server** for
`cognify`/`search` to work — that is the server's configuration, not this node's.

## Limits

- **`cognify` is synchronous and can be slow** (minutes on large datasets). Keep `request_timeout`
  generous, or use `run_in_background` and re-check later.
- **`add` accepts one text (or URL) per call** and stores it as an uploaded document; it does not
  build the graph on its own.
- **`cognee.reset` deletes the whole dataset record**, not just its contents (cognee has no
  empty-but-keep endpoint over REST); a later `add` recreates the dataset. There is no
  prune-over-REST in cognee, so `reset` is dataset-scoped, not a system prune.
- Memory is only searchable **after** `cognify` completes for that dataset.

## Examples

Wire `tool_cognee` to an agent over a `control` connection. A minimal agent turn:

1. `cognee.add` — `{ "text": "Ada Lovelace wrote the first algorithm." }`
2. `cognee.cognify` — `{}` (builds the graph for the configured dataset)
3. `cognee.search` — `{ "query": "Who wrote the first algorithm?" }`

## Upstream docs

- Cognee docs: https://docs.cognee.ai
- REST API server: https://docs.cognee.ai/how-to-guides/cognee-sdk/rest-api-server
- Search types: https://docs.cognee.ai/core-concepts/main-operations/search
- Cognee Cloud: https://platform.cognee.ai

## Troubleshooting

- **`search` returns nothing / 422** — content was added but not cognified. Call `cognee.cognify`
  for the dataset first, and confirm you are searching the same dataset you added to.
- **401 / 403** — the server has access control on and the API key is missing, wrong, or lacks
  permission on the dataset. Set `api_key` (or `COGNEE_API_KEY`).
- **Connection refused / timeout** — `base_url` is wrong or the cognee server isn't running. From
  a containerized engine, reach the host with `http://host.docker.internal:8000`.
- **`cognify` times out** — large ingest; raise `request_timeout` or set `run_in_background`.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
