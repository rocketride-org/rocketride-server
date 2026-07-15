# Cognee node

Adds persistent semantic memory to an agent through four tools:
`cognee.remember`, `cognee.recall`, `cognee.pipeline_status`, and
`cognee.export_visualization`.

This remains a `tool` node (`classType: ["tool"]`, invoke capability, no data lanes). It
complements RocketRide's run-scoped memory with an external memory service that the agent invokes
only when needed.

## What it does

Cognee turns plain text into a semantic knowledge graph and embeddings, then recalls grounded
answers with references. The graph represents semantic relationships. It is not an AST, import
graph, or call graph, and this node does not accept a repository URL for generic source ingestion.

Memory is grouped by dataset. Each call uses the configured dataset unless the agent supplies a
nonempty override.

## Tools

- **`cognee.remember`** sends plain text to `POST /api/v1/remember`, which stores the text and
  starts graph processing in one operation. Set `run_in_background` to return while processing
  continues.
- **`cognee.recall`** sends a natural-language query to `POST /api/v1/recall`. References are
  always enabled. The default strategy is `GRAPH_COMPLETION_DECOMPOSITION`.
- **`cognee.pipeline_status`** resolves the configured dataset name to its UUID, then checks the
  cognify pipeline. It returns one of `pending`, `running`, `completed`, or `failed`.
- **`cognee.export_visualization`** resolves the dataset UUID, fetches its interactive semantic
  graph, and writes a mode-0600 HTML artifact below `artifact_dir`. It returns the absolute path,
  SHA-256 hash, byte count, and media type, never raw HTML.

There is no destructive clear/reset tool.

## Setup

Point `base_url` at the Cognee server:

- **Self-hosted:** the REST API defaults to `http://localhost:8000`. From a containerized engine,
  use a host address reachable from that container.
- **Cognee Cloud:** use the instance URL from
  [platform.cognee.ai](https://platform.cognee.ai).

The API key is optional for a self-hosted server with access control disabled. Otherwise set the
secure `api_key` field or `COGNEE_API_KEY` environment variable. Never commit a key.

`artifact_dir` must resolve to an absolute path. Its default,
`~/.rocketride/artifacts/cognee`, expands under the engine user's home directory. Visualization
files are atomically replaced and readable only by that user.

## Example

Wire `tool_cognee` to an agent over a tool/control connection. A typical sequence is:

1. `cognee.remember` with `{ "text": "Ada Lovelace wrote the first algorithm." }`.
2. If it ran in the background, poll `cognee.pipeline_status` until it reports `completed`.
3. `cognee.recall` with `{ "query": "Who wrote the first algorithm?" }`.
4. Optionally call `cognee.export_visualization` to inspect the semantic graph artifact.

## Limits

- `remember` accepts plain text only and is not retried automatically because retrying a write
  could duplicate ingestion.
- `recall` always asks Cognee for references and does not retry its generation request.
- Status and visualization require the dataset to exist and resolve by exact name.
- This node never returns visualization HTML to the agent. Only local artifact metadata is
  returned.

## Upstream docs

- Cognee docs: https://docs.cognee.ai
- REST API server: https://docs.cognee.ai/how-to-guides/cognee-sdk/rest-api-server
- Cognee Cloud: https://platform.cognee.ai

## Troubleshooting

- **Dataset not found:** verify the exact configured dataset name and that `remember` created it.
- **Recall is empty:** wait for `pipeline_status` to report `completed`, then query the same
  dataset.
- **401 / 403:** set a valid API key for Cognee Cloud or an access-controlled self-hosted server.
- **402:** the Cognee token budget is exhausted; add capacity before retrying paid processing.
- **Connection refused / timeout:** verify `base_url` from the engine's network environment.
- **Artifact path error:** configure an absolute `artifact_dir` that the engine user can create and
  write.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
