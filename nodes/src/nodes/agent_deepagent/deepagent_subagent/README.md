---
title: DeepAgent Subagent
date: 2026-04-13
sidebar_position: 2
---

<head>
  <title>DeepAgent Subagent - RocketRide Documentation</title>
</head>

## What it does

Managed sub-agent driven by a `Deep Agent` orchestrator over the `deepagent` invoke channel. The orchestrator fans out `describe` to collect this sub-agent's description, system prompt, and instructions, then builds it into a `deepagents.SubAgent` record callable via the orchestrator LLM's `task` tool.

**Lanes:** none — this node is driven by an orchestrator, not by direct questions.

## Connections

| Channel | Required | Description                       |
| ------- | -------- | --------------------------------- |
| `llm`   | yes      | LLM this sub-agent thinks with    |
| `tool`  | no       | Tools available to this sub-agent |

The sub-agent's LLM and tool channels are independent of the orchestrator's. When the orchestrator delegates to this sub-agent, LLM and tool calls are routed back through this node's own channels.

## Configuration

**Always visible:**

| Field       | Description                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Description | Short specialization summary. **This is the only signal the orchestrator reads to decide when to delegate.** |

Toggle **Advanced Mode** to replace _Instructions_ with a full _System Prompt_ field.

**Normal Mode:**

| Field        | Description                                              |
| ------------ | -------------------------------------------------------- |
| Instructions | Lines appended to this sub-agent's default system prompt |

**Advanced Mode:**

| Field         | Description                                                         |
| ------------- | ------------------------------------------------------------------- |
| System Prompt | The sub-agent's full system prompt (overrides the built-in default) |

## Pipeline wiring

Must be wired into a `Deep Agent` node's `deepagent` channel. **Can be connected to multiple orchestrators simultaneously** — each orchestrator independently includes this sub-agent in its own hierarchical run.

This node has **no `questions` lane** and cannot be invoked directly. It also cannot be called as a tool via `tool.run_agent` — Subagent's `classType` is `["deepagent"]` only. For a DeepAgent that runs standalone or can be called as a tool by other agents, use the `Deep Agent` node instead.
