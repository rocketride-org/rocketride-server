---
title: Troubleshooting
---

# Troubleshooting

Common issues when building and running pipelines, and how to fix them.

## Can't connect to the engine

- **Connection refused / timeout.** Nothing is listening on the URI. Start a
  local engine (the [VS Code extension](/ide-extensions/overview) or a
  [self-hosted](/self-hosting) container on port 5565), or point
  `ROCKETRIDE_URI` at your [Cloud](/cloud) endpoint.
- **Unauthorized against Cloud.** Set `ROCKETRIDE_AUTH` (or `ROCKETRIDE_APIKEY`)
  to a valid API token.
- **Silent insecure downgrade.** Against Cloud, an `http://`/`ws://` (or bare
  `host:port`) URI drops to an unencrypted connection. Use `https://` or
  `wss://`, see the [WebSocket protocol](/protocols/websocket).

## Pipeline starts but no output comes back

- **Wrong source for the job.** A `chat` source expects `chat()`; a `webhook` /
  file source expects `send()` / `pipe()` (or [`upload`](/cli)). Driving a chat
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
- [Pipeline JSON Reference](/pipeline-reference): every field of a `.pipe`.
- [Glossary](/glossary): terms used across the docs.
