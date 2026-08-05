---
title: Advanced Agents
sidebar_position: 9
---

# Advanced Agents

This page builds on the foundations in [Agents & Tools](/concepts/agents-tools-skills)
to cover multi-agent patterns, memory strategies, and safety techniques for
production agent pipelines.

## Multi-agent hierarchies

A manager agent can invoke a specialist agent as a tool. The specialist is just
another pipeline; it has its own source, its own nodes, and its own response
target. The manager calls it the same way it calls any other tool: by sending a
question and receiving an answer.

```text
manager-pipeline.pipe
  source_1 (webhook)
  agent_1 (agent_rocketride)   ← manager
    ↓ invokes via tool call
    specialist-pipeline.pipe
      source_1 (webhook)
      llm_1 (llm_openai)
      target_1 (response)
```

The [`agent_rocketride`](/nodes/agent_rocketride) node supports this pattern
natively — expose any running pipeline as an MCP tool (see
[MCP Server](/protocols/mcp)) and the manager agent can call it.

This is useful when different specialists need different models, memory, or
tool sets. Keep each specialist pipeline small and single-purpose.

## Parallel tool calls

When an agent's reasoning step identifies multiple independent tool calls, the
engine fans them out concurrently. If the agent decides to search the vector
store AND look up a database row in the same step, both calls happen in
parallel and the results are merged before the next reasoning step.

This behaviour is automatic — no pipeline configuration is required. The
latency of a multi-tool step is bounded by the slowest tool, not the sum of all
tool latencies.

## Agent-as-tool via MCP

Any running RocketRide pipeline is automatically exposed as an MCP tool by the
[MCP server](/protocols/mcp). This means a Claude Desktop or Cursor session can
invoke your pipeline as a tool, making your pipeline an agent capability in an
external system.

To use a pipeline as a tool in another RocketRide agent, expose it via MCP and
configure the consuming agent's `tool_mcp_client` node to point at the MCP
server.

## Memory strategies

Memory nodes give agents context across turns. The right choice depends on
what you need to survive and how:

| Strategy | Node | Persists across | Use when |
| --- | --- | --- | --- |
| **Session memory** | [`memory_internal`](/nodes/memory_internal) | Nothing (resets on restart) | Conversation context within one session only |
| **Persistent memory** | [`memory_persistent`](/nodes/memory_persistent) | Pipeline restarts | Context must survive restarts; backed by a configured store |
| **Long-term semantic memory** | `tool_mem0` | Restarts; searchable | Agent should recall extracted facts and user preferences across many sessions |

For most conversational agents, `memory_internal` is the right default. Add
`memory_persistent` when sessions must resume after a restart. Use `tool_mem0`
when the agent is expected to build a model of the user or domain over many
interactions.

When using persistent or long-term memory, scope it tightly. Storing everything
degrades retrieval quality. Use the memory node's summarisation or extraction
settings to store only meaningful context.

## Guardrails in agent pipelines

Place a [`guardrails`](/nodes/guardrails) node on the `answers` lane **between
the agent and the response target** to validate outputs before they reach the
caller:

```text
agent_1 → (answers lane) → guardrails_1 → target_1 (response)
```

The guardrails node can check for:

- Harmful or policy-violating content.
- Outputs that fail a format constraint (e.g. must be valid JSON).
- Answers that contain PII when they should not.

If a check fails, the guardrails node blocks the output. The pipeline run
stops cleanly rather than returning an invalid answer to the caller.

## Limiting agent scope

Agents are powerful, but an agent with too many tools becomes hard to reason
about and may make unexpected tool calls. Keep the tool set small and specific:

- Give each agent only the tools it needs for its task.
- Use a `prompt` node to explicitly tell the agent which tools to prefer.
- Use the `max_iterations` config (where available) to cap reasoning loops —
  an unbounded loop is a latency and cost risk.

## Related

- [Concepts: Agents & Tools](/concepts/agents-tools-skills): control connections, wiring.
- [MCP Server](/protocols/mcp): exposing pipelines as MCP tools.
- [Concepts: Error Handling](/concepts/error-handling): handling agent failures.
- [Best Practices](/concepts/best-practices): agents vs. direct LLM calls.
