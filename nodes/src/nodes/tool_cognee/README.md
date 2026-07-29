# Cognee node

Adds persistent semantic memory to agents through three tools:
`cognee.remember`, `cognee.recall`, and `cognee.memory_status`.

This is a `tool` node (`classType: ["tool"]`, invoke capability, no data lanes). Multiple agents
can connect to the same Cognee node and share its operator-configured dataset.

## What it does

Cognee turns plain text into a semantic knowledge graph and embeddings. Recall always requests
references from Cognee, but this node does not require every returned result to contain references.
The graph represents semantic relationships. It is not an AST, import graph, or call graph, and the
node does not accept repository URLs for generic source ingestion.

Memory is grouped by dataset. By default, every tool call is locked to the dataset configured on
the node. Per-call dataset selection works only when `allow_dataset_override` is set to `true`.

## Tools

- **`cognee.remember`** sends plain text to `POST /api/v1/remember`, storing and processing it in
  one operation. Set `run_in_background` to return while processing continues.
- **`cognee.recall`** sends a natural-language query to `POST /api/v1/recall`. It always requests
  references and defaults to `GRAPH_COMPLETION_DECOMPOSITION`.
- **`cognee.memory_status`** resolves the selected dataset name to its UUID and checks the Cognify
  pipeline. It returns `pending`, `running`, `completed`, or `failed`.

There is no destructive clear/reset tool.

## REST API contract provenance

This node follows Cognee's [Recall API reference](https://docs.cognee.ai/api-reference/recall/recall) and [Get Datasets API reference](https://docs.cognee.ai/api-reference/datasets/get-datasets), checked 2026-07-21. `POST /api/v1/recall` uses the documented camelCase JSON fields `searchType`, `topK`, and `includeReferences`; this node always sends `includeReferences: true`. `GET /api/v1/datasets` is called without pagination parameters and expects Cognee's documented bare JSON list response.

## Setup

Configure these node settings:

- `base_url`: Cognee server URL. Self-hosted Cognee defaults to `http://localhost:8000`; a
  containerized engine needs an address reachable from the container. For Cognee Cloud, use the
  instance URL from [platform.cognee.ai](https://platform.cognee.ai).
- `api_key`: optional for self-hosted servers with access control disabled. Otherwise set the
  secure field or the `COGNEE_API_KEY` environment variable. Never commit a key.
- `dataset`: shared default dataset for all connected agents. Defaults to `main`.
- `allow_dataset_override`: permits a tool call to select a different dataset. Defaults to `false`.
- `search_type`: default recall strategy. Defaults to `GRAPH_COMPLETION_DECOMPOSITION`.
- `top_k`: default recall result limit from 1 through 100. Defaults to 15.
- `request_timeout`: per-request timeout from 5 through 600 seconds. Defaults to 120.

## Shared-agent example

See the copyable
[`cognee-shared-memory-agents.pipe`](../../../../examples/cognee-shared-memory-agents.pipe)
pipeline. A RocketRide component can have multiple tool/control entries, so one `tool_cognee` node
can be controlled by both the writer and researcher agents. Prefer one shared Cognee node to
duplicating it for each agent: one component keeps the server, credentials, dataset, and retrieval
settings from drifting apart.

Shared recall requires all participants to use the same Cognee server, an authenticated identity
with permissions to the shared memory, and the same dataset. Leave `allow_dataset_override`
disabled to keep every call in the operator-controlled dataset; per-call dataset drift is rejected
unless the setting is explicitly enabled.

Wiring agents to Cognee does not automatically copy their prompts, transcripts, or tool results.
An agent must explicitly call `cognee.remember` to create durable memory, and another agent must
explicitly call `cognee.recall` to retrieve it. Each `agent_rocketride` still needs its own
`memory_internal` control for run-scoped working memory. Cognee adds durable cross-agent memory; it
does not replace that working memory.

Simultaneous writes from shared agents may overlap. This node provides no transaction,
serialization, or ordering guarantee across tool calls, and recall is eventually consistent with
processing. Prefer a sequential handoff: let the storing agent finish, wait for
`cognee.memory_status` to report `completed`, and only then have the receiving agent recall.

To test the example sequentially:

1. Set `COGNEE_BASE_URL`, `COGNEE_API_KEY`, and `ROCKETRIDE_ANTHROPIC_KEY`, then open the example.
2. Send this prompt. It gives the writer only a research subject, not the fact that must cross the
   agent boundary:

   ```text
   Ask the researcher to identify one lesser-known fact about Grace Hopper and store it in shared
   memory. The researcher must return only a storage confirmation, not the fact. After processing
   completes, recover the fact yourself from shared memory and tell me what it is.
   ```

   The researcher independently determines the fact, calls `cognee.remember`, and returns only a
   storage confirmation.
3. If remember ran in the background, have the writer call `cognee.memory_status` until the shared
   dataset reports `completed`.
4. Have the writer call `cognee.recall` for the fact and produce the final response from recalled
   memory, without receiving the fact directly from the researcher.

## Limits

- `remember` accepts plain text only and is not retried automatically because retrying a write
  could duplicate ingestion.
- `recall` requests references and is also single-attempt because it may perform generation.
- Dataset discovery and status checks are idempotent GETs and use RocketRide's shared retry helper.
- `memory_status` requires the dataset to exist and resolve by exact name.
- Per-call dataset values are rejected unless `allow_dataset_override` is enabled.
- No destructive dataset operation is exposed to an agent.

## Troubleshooting

- **Dataset not found:** verify the exact configured dataset name and that `remember` created it.
- **Dataset override rejected:** enable `allow_dataset_override`, or omit the per-call `dataset` so
  the configured dataset is used.
- **Recall is empty:** wait for `memory_status` to report `completed`, then query the same dataset.
- **401 / 403:** set a valid API key for Cognee Cloud or an access-controlled self-hosted server.
- **402:** the Cognee token budget is exhausted; add capacity before retrying paid processing.
- **Connection refused / timeout:** verify `base_url` from the engine's network environment.

## Upstream docs

- Cognee docs: https://docs.cognee.ai
- Cognee API reference: https://docs.cognee.ai/api-reference/introduction
- Cognee Cloud: https://platform.cognee.ai

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
