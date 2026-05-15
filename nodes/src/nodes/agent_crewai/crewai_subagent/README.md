---
title: CrewAI Subagent
date: 2026-04-11
sidebar_position: 4
---

<head>
  <title>CrewAI Subagent - RocketRide Documentation</title>
</head>

## What it does

Managed [CrewAI](https://docs.crewai.com/) sub-agent. Wired into a `CrewAI Manager` via the `crewai` invoke channel. The Manager fans out `describe` to collect this sub-agent's role, goal, backstory, and task, then builds it into its own hierarchical `Crew`.

**Lanes:** none — this node is driven by a Manager, not by direct questions.

## Connections

| Channel | Required | Description                       |
| ------- | -------- | --------------------------------- |
| `llm`   | yes      | LLM this sub-agent thinks with    |
| `tool`  | no       | Tools available to this sub-agent |

The sub-agent's LLM and tool channels are independent of the Manager's. When the Manager delegates to this sub-agent, LLM and tool calls are routed back through this node's own channels.

## Configuration

By default only **Agent Description** and **Instructions** are shown. Toggle **Advanced Mode** to expose CrewAI-specific fields.

**Always visible:**

| Field             | Description                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Agent Description | What this sub-agent specializes in — used by the Manager when deciding who to delegate to |
| Instructions      | Extra guidance appended to this sub-agent's backstory                                     |

**Advanced Mode — Agent:**

| Field     | Default      | Maps to                |
| --------- | ------------ | ---------------------- |
| Role      | `Specialist` | `Agent(role=...)`      |
| Goal      | built-in     | `Agent(goal=...)`      |
| Backstory | built-in     | `Agent(backstory=...)` |

**Advanced Mode — Task:**

| Field           | Default             | Maps to                     |
| --------------- | ------------------- | --------------------------- |
| Task            | _(incoming prompt)_ | `Task(description=...)`     |
| Expected Output | built-in            | `Task(expected_output=...)` |

## Pipeline wiring

Must be wired into a `CrewAI Manager`'s `crewai` channel. **Can be connected to multiple Managers simultaneously** — each Manager independently includes this sub-agent in its own hierarchical `Crew`. This enables shared specialist sub-agents across multiple delegation hierarchies.

This node has **no `questions` lane** and cannot be invoked directly. It also cannot be called as a tool via `tool.run_agent` — Subagent's `classType` excludes `"tool"`. For a CrewAI agent that runs standalone or can be called as a tool by other agents, use the `CrewAI Agent` node instead.
