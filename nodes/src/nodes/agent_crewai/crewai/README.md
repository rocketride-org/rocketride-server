---
title: CrewAI
date: 2026-03-02
sidebar_position: 3
---

<head>
  <title>CrewAI - RocketRide Documentation</title>
</head>

## What it does

Single-agent [CrewAI](https://docs.crewai.com/) node. Receives a question, runs a one-agent `Crew`, and emits an answer.

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

## Using as a sub-agent

Wire into a `CrewAI Manager` node via the `crewai` invoke channel. The manager invokes `crewai.describe` to collect this node's role, goal, backstory, and task. Tool resolution is handled separately by the manager and is not a direct field in the `crewai.describe` response.
