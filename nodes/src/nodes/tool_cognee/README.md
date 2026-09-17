# tool_cognee

A RocketRide tool node that gives agents persistent semantic memory through a Cognee server, with explicit storage, retrieval, and processing-status tools.

## About Cognee

Cognee is the external semantic-memory service this node accesses through its REST API. Its memory workflow stores plain text, builds a semantic knowledge graph, and recalls results with references.

## What it does

Use this node when agents need durable semantic memory that outlives a single tool call or agent run. It exposes agent tools only—there are no pipeline lanes—and keeps the configured dataset as the default memory scope. Pick it over run-scoped agent memory when another agent or a later call must deliberately store and retrieve semantic memory; it does not inspect source-code ASTs, import graphs, or call graphs.

## As a tool

The registered prefix is `cognee`, so the agent sees `cognee.remember`, `cognee.recall`, and `cognee.memory_status`.

| Function | Description |
|---|---|
| `cognee.remember` | Stores plain text in a dataset and starts semantic-memory processing. |
| `cognee.recall` | Retrieves memory results for a natural-language query, always requesting references. |
| `cognee.memory_status` | Reports whether the configured dataset's processing is pending, running, completed, or failed. |

### `cognee.remember`

`text` is required and must be non-empty plain text. Optional `dataset` must be the configured dataset unless dataset override is enabled; optional boolean `run_in_background` returns after queuing processing when true. The server response must contain a non-empty `status` and may include dataset and pipeline-run identifiers. Invalid input raises an error; failed requests raise redacted Cognee errors, and this non-idempotent request is not retried.

### `cognee.recall`

`query` is required and non-empty. Optional `dataset` follows the same scope rule; optional `search_type` must be one of the configured supported strategies, and optional `top_k` must be an integer. The result is `results` plus `count`; references are always requested from the server. Invalid input or server failures raise errors rather than returning an empty recall result.

### `cognee.memory_status`

`dataset` is optional and defaults to the configured dataset, subject to the same override rule. Before requesting status, the node lists datasets and resolves the name by exact match. It returns the dataset name and ID plus one of `pending`, `running`, `completed`, or `failed`. An unresolved dataset or an invalid server response raises an error.

## Configuration

Set the server URL and dataset first. The remaining settings control which data an agent may select, how recall is requested, and how much time each request can consume.

### Server URL and API Key

**Server URL** defaults to `http://localhost:8000`; trailing slashes are removed before requests. An absent or empty field uses that default, while a whitespace-only configured URL prevents startup. **API Key** is optional for a self-hosted server that accepts unauthenticated requests; when the field is blank, the node falls back to `COGNEE_API_KEY` and sends it as the `X-Api-Key` header. Set the URL to the reachable server from the engine environment and add a key when that server requires access control.

### Dataset and Allow dataset override

**Dataset** defaults to `main` and is the scope used whenever a call omits `dataset`. Keep **Allow dataset override** disabled to stop agents from selecting a different dataset; it is enabled only by the boolean value `true`. Enable it only when the agent is intentionally allowed to work across separate memory scopes.

### Default recall strategy and Recall results (top_k)

The default strategy is `GRAPH_COMPLETION_DECOMPOSITION`. Configuration is normalized to uppercase and falls back to that default if it is unsupported; a tool-call override must be a supported strategy or the call fails. **Recall results (top_k)** defaults to 15 and is clamped from 1 through 100 in configuration; a call override must be an integer and is then clamped to the same range. Raise it when broader recall is needed, while keeping it lower when an agent needs a focused result set.

### Request timeout (s)

This is the timeout for every Cognee request and defaults to 120 seconds. Configuration is clamped from 5 through 600 seconds; increase it only for a server whose processing or retrieval normally takes longer, because every tool call waits up to this bound.

## Authentication

For an access-controlled Cognee server, provide **API Key** or set `COGNEE_API_KEY`. The node does not send an `X-Api-Key` header when neither source supplies a key, which supports self-hosted servers configured for unauthenticated access.

## Notes

### Request behavior

`remember` and `recall` use one POST attempt. Dataset listing and status checks use the shared retrying GET helper. For background storage, call `memory_status` and wait for `completed` before relying on a recall result.

### Shared memory across agents

A RocketRide component may carry multiple tool/control entries, so one `tool_cognee` node can serve several agents at once. Prefer that to duplicating the node per agent: one component keeps the server, credentials, dataset, and retrieval settings from drifting apart. Shared recall requires every participant to use the same Cognee server, an authenticated identity with permission to the shared memory, and the same dataset — keep **Allow dataset override** disabled so no agent can select a different dataset. Memory never moves implicitly: an agent must call `cognee.remember` to store, and another must call `cognee.recall` to retrieve; each agent still needs its own run-scoped working memory.

Simultaneous writes may overlap. The node provides no transaction, serialization, or ordering guarantee across tool calls, and recall is eventually consistent with processing. Prefer a sequential handoff: let the storing agent finish, wait for `cognee.memory_status` to report `completed`, and only then have the receiving agent recall. See the copyable [`cognee-shared-memory-agents.pipe`](https://github.com/rocketride-org/rocketride-server/blob/develop/examples/cognee-shared-memory-agents.pipe) example.

## Upstream docs

- [Cognee documentation](https://docs.cognee.ai)
- [Cognee API reference](https://docs.cognee.ai/api-reference/introduction)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `cognee.allow_dataset_override` | `boolean` | **Allow dataset override**<br/>Allow agents to select a dataset per call. Leave off when several agents should share one operator-controlled memory scope. | `false` |
| `cognee.api_key` | `string` | **API Key**<br/>Cognee API key sent as the <code>X-Api-Key</code> header. Falls back to <code>COGNEE_API_KEY</code>. Self-hosted servers with access control disabled can leave this blank. | `""` |
| `cognee.base_url` | `string` | **Server URL**<br/>Base URL of the Cognee server. Self-hosted Cognee defaults to <b>http://localhost:8000</b>. For Cognee Cloud, use the instance URL from <a href='https://platform.cognee.ai' target='_blank'>platform.cognee.ai</a>. | `"http://localhost:8000"` |
| `cognee.dataset` | `string` | **Dataset**<br/>Default Cognee dataset used by all agent tools. Tool calls stay in this operator-controlled scope unless per-call overrides are enabled. | `"main"` |
| `cognee.request_timeout` | `integer` | **Request timeout (s)**<br/>Maximum seconds to wait for one Cognee request. | `120` |
| `cognee.search_type` | `string` | **Default recall strategy**<br/>How recall retrieves memory. Graph completion decomposition is the semantic default; the agent can override it per call. | `"GRAPH_COMPLETION_DECOMPOSITION"` |
| `cognee.top_k` | `integer` | **Recall results (top_k)**<br/>Maximum number of results recall retrieves per query. | `15` |

## Dependencies

- `requests` `>=2.34.2`
- `tenacity`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_cognee)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
