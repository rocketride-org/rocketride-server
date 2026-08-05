---
title: Error Handling
sidebar_position: 6
---

# Error Handling

Errors in RocketRide fall into two categories depending on when they occur and
what they affect.

## Startup errors (init-time)

Startup errors occur when the engine validates and initialises the pipeline
before any data flows. Examples:

- **Invalid configuration** — a required field is missing, a value is out of
  range, or a referenced profile does not exist.
- **Dependency failure** — a Python package is missing or failed to import.
- **Validation call failure** — nodes like `llm_openai` make a test API call on
  startup to verify the key and model name are valid. If the call fails, the
  pipeline does not start.
- **Lane mismatch** — a node is wired to receive a lane type it does not accept
  (e.g. `text` wired to a node that only accepts `questions`).

When a startup error occurs, the engine reports it immediately and the pipeline
does not run. No data is processed.

## Runtime errors

Runtime errors occur during execution, after the pipeline has started
successfully. Examples:

- **LLM API error** — rate limit exceeded, context window overflow, downstream
  service outage.
- **Vector store timeout** — the store is unreachable or the query takes too long.
- **Preprocessing failure** — a document is malformed and cannot be chunked.
- **Agent loop error** — the agent exceeds its maximum iteration count or a tool
  call fails.

A runtime error **stops the current pipeline run**. The engine emits an error
event over WebSocket with the node ID and message, then halts. Nodes that have
already produced output on their lanes are not rolled back — any data they
streamed downstream before the error stands.

Concurrent runs (other active tasks on the same pipeline) are not affected.

## Error events

The engine emits structured error events over the [WebSocket
protocol](/protocols/websocket). Each event includes:

- The **node ID** where the error originated.
- An **error message** and type.
- A **stack trace** for Python-level errors.

The CLI prints these to the terminal as they arrive. SDK clients receive them
on the event stream. The [Observability](/protocols/websocket/observability)
page documents the event schema.

## Recovery patterns

### Agent retry loops

Agent nodes have a configurable `max_attempts` (or similar) parameter. When a
tool call fails, the agent can retry with a modified call. This handles
transient failures in external APIs without propagating an error to the
pipeline level.

### Fallback LLM profiles

If your primary model is unavailable, swap the `profile` to a fallback. Some
teams maintain two `.pipe` files, one using a premium model profile and one using
a cheaper or locally-hosted fallback, and switch between them by passing the
chosen file to the `rocketride` CLI's `--pipeline` flag (`rocketride start
--pipeline ./fallback.pipe`).

### Guardrails as a safety net

A [`guardrails`](/nodes/guardrails) node placed on the `answers` lane validates
LLM output before it reaches the response target. If the output fails
validation, the guardrail can block it or route it to an error handler rather
than returning it to the caller.

### Observability-driven debugging

Use the `status` CLI command or the WebSocket event stream to watch a pipeline
run in real time. Error events pinpoint the failing node, which is usually
enough to diagnose configuration issues:

```bash
rocketride status --token <task-token>
```

## Related

- [WebSocket: Observability](/protocols/websocket/observability): full error event schema.
- [Best Practices](/concepts/best-practices): credential and lane-type pitfalls.
- [Nodes: Guardrails](/nodes/guardrails): output validation.
