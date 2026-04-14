---
title: Deep Agent
date: 2026-04-13
sidebar_position: 1
---

<head>
  <title>Deep Agent - RocketRide Documentation</title>
</head>

## What it does

Agent node built on the [`deepagents`](https://github.com/langchain-ai/deepagents) library (LangChain/LangGraph). Adds strategic planning, persistent state, and long-context management on top of a standard LangChain agent loop.

Runs standalone with its own tools, or as an orchestrator that delegates to connected `DeepAgent Subagent` nodes on the `deepagent` invoke channel. Subagents are optional — behaviour matches the old single-agent node when none are wired.

**Lanes:** `questions` → `answers`

## Connections

| Channel     | Required | Description                                         |
| ----------- | -------- | --------------------------------------------------- |
| `llm`       | yes      | LLM the agent thinks with                           |
| `tool`      | no       | Tools available to the agent                        |
| `deepagent` | no       | Connected `DeepAgent Subagent` nodes for delegation |

## Configuration

By default only **Instructions** is shown. Toggle **Advanced Mode** to expose the agent description and system prompt directly.

**Normal Mode:**

| Field        | Description                                         |
| ------------ | --------------------------------------------------- |
| Instructions | Lines appended to the agent's default system prompt |

**Advanced Mode:**

| Field             | Description                                                          |
| ----------------- | -------------------------------------------------------------------- |
| Agent Description | What this agent does — used by parent agents to select and invoke it |
| System Prompt     | The agent's full system prompt (overrides the built-in default)      |

## Tool calling

This node uses a **JSON envelope protocol** for tool calling — the host LLM is instructed to output either `{"type":"tool_call","name":"...","args":{...}}` or `{"type":"final","content":"..."}`. Works with any LLM that can follow JSON instructions, not just ones with native function-calling support. Up to 3 retries are attempted when the LLM produces malformed JSON, and a tolerant parser rescues responses with trailing content or a stray second object.

## Hierarchical delegation

Connect one or more `DeepAgent Subagent` nodes on the `deepagent` channel to enable delegation. On each run the orchestrator fans out a `describe` invoke, collects each subagent's descriptor, builds a `deepagents.SubAgent` record per subagent wired to its own LLM + tool channels, and passes them to `create_deep_agent(subagents=...)`. The orchestrator's LLM then calls the `task(description, subagent_type)` tool to delegate — each subagent runs inside its own `AgentContext` so SSE events route back to the same logical run.

## Using as a tool

This node exposes itself as an invokable tool (`<nodeId>.run_agent`) so parent agents can delegate to it in nested pipelines.
