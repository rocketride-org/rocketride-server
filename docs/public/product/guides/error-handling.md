---
title: Error Handling
---

# Error Handling

Patterns for keeping pipelines useful when things fail. For the taxonomy of
*what* can fail — startup vs. runtime errors and how the engine reports them —
see [Troubleshooting](/support/troubleshooting); the event format lives in
[WebSocket Events](/connect/websocket/observability).

A runtime error stops the current pipeline run: the engine emits an error event
with the node ID and message, then halts. Nodes that already streamed output
are not rolled back, and concurrent runs on the same pipeline are unaffected.
The patterns below keep a single failure from becoming an outage.

## Agent retry loops

`agent_rocketride` has a configurable `max_waves` parameter that caps the
number of reasoning cycles (it is not a per-tool retry count). When a tool call
fails, the agent can retry with a modified call in a later wave. This handles
transient failures in external APIs without propagating an error to the
pipeline level.

## Fallback LLM profiles

If your primary model is unavailable, swap the `profile` to a fallback. Some
teams maintain two `.pipe` files, one using a premium model profile and one using
a cheaper or locally-hosted fallback, and switch between them by passing the
chosen file to the `rocketride` CLI's `--pipeline` flag (`rocketride start
--pipeline ./fallback.pipe`).

## Guardrails as a safety net

A [`guardrails`](/nodes/guardrails) node placed on the `answers` lane validates
LLM output before it reaches the response target. If the output fails
validation, the guardrail can block it or route it to an error handler rather
than returning it to the caller.

## Observability-driven debugging

Use the `status` CLI command or the WebSocket event stream to watch a pipeline
run in real time. Error events pinpoint the failing node, which is usually
enough to diagnose configuration issues:

```bash
rocketride status --token <task-token>
```

## Related

- [Troubleshooting](/support/troubleshooting): symptom → cause → fix, and the error taxonomy.
- [WebSocket Events](/connect/websocket/observability): full error event schema.
- [Best Practices](/guides/best-practices): credential and lane-type pitfalls.
- [Nodes: Guardrails](/nodes/guardrails): output validation.
