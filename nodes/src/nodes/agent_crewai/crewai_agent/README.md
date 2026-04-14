---
title: CrewAI Agent
date: 2026-04-11
sidebar_position: 3
---

<head>
  <title>CrewAI Agent - RocketRide Documentation</title>
</head>

## What it does

Standalone single-agent [CrewAI](https://docs.crewai.com/) node. Receives a question, runs a one-agent `Crew`, and emits an answer. Can also be invoked as a tool by other agents via `<nodeId>.run_agent`.

**Lanes:** `questions` → `answers`

## Connections

| Channel | Required | Description                  |
| ------- | -------- | ---------------------------- |
| `llm`   | yes      | LLM the agent thinks with    |
| `tool`  | no       | Tools available to the agent |

## Configuration

By default only **Agent Description** and **Instructions** are shown. Toggle **Advanced Mode** to expose CrewAI-specific fields.

**Always visible:**

| Field             | Description                                                          |
| ----------------- | -------------------------------------------------------------------- |
| Agent Description | What this agent does — used by parent agents to select and invoke it |
| Instructions      | Extra guidance appended to the agent's backstory                     |

**Advanced Mode — Agent:**

| Field     | Default     | Maps to                |
| --------- | ----------- | ---------------------- |
| Role      | `Assistant` | `Agent(role=...)`      |
| Goal      | built-in    | `Agent(goal=...)`      |
| Backstory | built-in    | `Agent(backstory=...)` |

**Advanced Mode — Task:**

| Field           | Default             | Maps to                     |
| --------------- | ------------------- | --------------------------- |
| Task            | _(incoming prompt)_ | `Task(description=...)`     |
| Expected Output | built-in            | `Task(expected_output=...)` |

## Multi-agent workflows

For hierarchical multi-agent orchestration, use the `CrewAI Manager` node with one or more `CrewAI Subagent` nodes instead. A `CrewAI Agent` node cannot be used as a sub-agent under a Manager — that role is filled by `CrewAI Subagent`.
