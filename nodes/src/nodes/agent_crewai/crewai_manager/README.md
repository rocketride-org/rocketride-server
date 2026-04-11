---
title: CrewAI Manager
date: 2026-03-02
sidebar_position: 4
---

<head>
  <title>CrewAI Manager - RocketRide Documentation</title>
</head>

## What it does

Hierarchical [CrewAI](https://docs.crewai.com/) manager node. Fans out to all connected `CrewAI Subagent` nodes, assembles a `Process.hierarchical` Crew, and synthesizes their outputs into a final answer. Can also be invoked as a tool by other agents via `<nodeId>.run_agent` for cross-framework nesting.

**Lanes:** `questions` → `answers`

## Connections

| Channel  | Required    | Description                               |
| -------- | ----------- | ----------------------------------------- |
| `llm`    | yes         | LLM for the manager agent and planning    |
| `crewai` | yes (min 1) | Connected `CrewAI Subagent` nodes (min 1) |

The `crewai` channel accepts only `CrewAI Subagent` nodes. `CrewAI Agent` nodes cannot be used as sub-agents — their `classType` does not include `crewai`. The Manager itself also cannot be nested under another Manager (it lacks `classType: "crewai"`); cross-Manager composition is supported via `tool.run_agent` instead.

## Configuration

By default only **Instructions** is shown. Toggle **Advanced Mode** to expose the manager agent's CrewAI fields.

**Always visible:**

| Field        | Description                                             |
| ------------ | ------------------------------------------------------- |
| Instructions | Delegation guidance appended to the manager's backstory |

**Advanced Mode:**

| Field             | Default  | Maps to                |
| ----------------- | -------- | ---------------------- |
| Manager Goal      | built-in | `Agent(goal=...)`      |
| Manager Backstory | built-in | `Agent(backstory=...)` |

## How it works

1. Fans out `describe` to each connected `CrewAI Subagent` node individually
2. Each `CrewAI Subagent` responds with its role, goal, backstory, task description, expected output, and tools
3. The manager builds an `Agent + Task` per sub-agent, routing LLM and tool calls back through that sub-agent's own pipeline channels
4. Kicks off a hierarchical Crew with `planning=True` using the manager's LLM

The node raises an error at runtime if no sub-agents are connected or none respond to `describe`.
