---
title: Troubleshooting
---

# Troubleshooting

Common issues when building and running pipelines, and how to fix them.

## How errors are classified

Errors fall into two categories depending on when they occur:

- **Startup errors (init-time)** happen while the engine validates and
  initialises the pipeline, before any data flows: invalid configuration (a
  required field missing, a value out of range, a referenced profile that does
  not exist), a missing Python dependency, a failed validation call (nodes like
  `llm_openai` make a test API call on startup to verify the key and model),
  or a lane mismatch. The engine reports the error immediately and the
  pipeline does not run — no data is processed.
- **Runtime errors** happen during execution: an LLM API error (rate limit,
  context overflow, outage), a vector store timeout, a malformed document that
  cannot be chunked, or an agent exceeding its iteration cap. A runtime error
  **stops the current pipeline run**; nodes that already streamed output are
  not rolled back, and concurrent runs on the same pipeline are unaffected.

Either way the engine emits a structured error event over the
[WebSocket protocol](/connect/websocket) with the node ID, message and type,
and a stack trace for Python-level errors. The CLI prints these as they
arrive; SDK clients receive them on the event stream. The full schema is in
[WebSocket Events](/connect/websocket/observability), and recovery patterns
(retries, fallbacks, guardrails) live in
[Error Handling](/guides/error-handling).

## Can't connect to the engine

- **Connection refused / timeout.** Nothing is listening on the URI. Start a
  local engine (the [VS Code extension](/clients/vscode) or a
  [self-hosted](/operate/self-hosting) container on port 5565), or point
  `ROCKETRIDE_URI` at your [Cloud](/operate/cloud) endpoint.
- **Unauthorized against Cloud.** Set `ROCKETRIDE_APIKEY` to a valid API token
  (`ROCKETRIDE_AUTH` is read only by the MCP servers, not the SDKs or CLI).
- **Silent insecure downgrade.** Against Cloud, an `http://`/`ws://` (or bare
  `host:port`) URI drops to an unencrypted connection. Use `https://` or
  `wss://`, see the [WebSocket protocol](/connect/websocket).

## Pipeline starts but no output comes back

- **Wrong source for the job.** A `chat` source expects `chat()`; a `webhook` /
  file source expects `send()` / `pipe()` (or [`upload`](/connect/cli)). Driving a chat
  pipeline with `send()` (or vice versa) produces nothing. Match the method to
  the source node.
- **Pipeline isn't actually running.** Uploads against a stale or terminated
  task token return nothing. Start the pipeline, then feed it.

## The response is empty or under the wrong key

- **Response key mismatch.** A `response` node with a custom `laneName` puts the
  result under that name, not the default. Read the key your pipeline actually
  emits (the result's `result_types` tells you which key carries which
  [lane](/concepts/execution-model)), or use the default response config.

## "Lane not supported" / "Lane mismatch" errors

The output [lane](/concepts/execution-model) of one node must match the input
lane of the next. Check both ends against the
[Nodes](/nodes) and fix the mismatched `input` connection.

## Agent pipeline fails to start

- **Missing control connections.** Agents need their helpers wired via
  `control` on the helper, not the agent. `agent_rocketride` requires exactly
  one LLM **and** one memory; `agent_crewai` / `agent_langchain` take no memory.
  See [Agents & tools](/concepts/agents-tools-skills).

## Resources leak / connections pile up

Always close the client when done (use the SDK's context manager / `terminate()`),
and start a long-lived pipeline **once** rather than per request.

## Related

- [Execution model](/concepts/execution-model): how lanes and control flow.
- [Pipeline JSON Reference](/reference/pipeline-reference): every field of a `.pipe`.
- [Glossary](/reference/glossary): terms used across the docs.
