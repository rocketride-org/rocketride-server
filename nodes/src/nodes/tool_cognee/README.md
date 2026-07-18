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

Connect both agent nodes to one `tool_cognee` node over tool/control connections. Leave
`allow_dataset_override` disabled so both agents use the same operator-controlled dataset.

A typical sequence is:

1. One agent calls `cognee.remember` with
   `{ "text": "Ada Lovelace wrote the first algorithm." }`.
2. If processing runs in the background, either agent polls `cognee.memory_status` until it returns
   `completed`.
3. Either agent calls `cognee.recall` with
   `{ "query": "Who wrote the first algorithm?" }`.

## Limits

- `remember` accepts plain text only and is not retried automatically because retrying a write
  could duplicate ingestion.
- `recall` requests references and does not retry its generation request.
- `memory_status` requires the dataset to exist and resolve by exact name.
- Per-call dataset values are rejected unless `allow_dataset_override` is enabled.

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
- Cognee REST API: https://docs.cognee.ai/how-to-guides/cognee-sdk/rest-api-server
- Cognee Cloud: https://platform.cognee.ai

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
