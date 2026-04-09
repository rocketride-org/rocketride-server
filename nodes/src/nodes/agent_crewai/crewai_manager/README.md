---
title: CrewAI Manager
date: 2026-03-02
sidebar_position: 4
---

<head>
  <title>CrewAI Manager - RocketRide Documentation</title>
</head>

## What it does

Hierarchical [CrewAI](https://docs.crewai.com/) manager node. Fans out to all connected `CrewAI` sub-agents, assembles a `Process.hierarchical` Crew, and synthesizes their outputs into a final answer.

**Lanes:** `questions` → `answers`

## Connections

| Channel  | Required    | Description                            |
| -------- | ----------- | -------------------------------------- |
| `llm`    | yes         | LLM for the manager agent and planning |
| `crewai` | yes (min 1) | Connected `CrewAI` sub-agent nodes     |

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

1. Fans out `crewai.describe` to each connected `CrewAI` node individually
2. Each sub-agent responds with its role, goal, backstory, task description, expected output, and tools
3. The manager builds a `Agent + Task` per sub-agent, routing LLM and tool calls back through that sub-agent's own pipeline channels
4. Kicks off a hierarchical Crew with `planning=True` using the manager's LLM

The node raises an error at runtime if no sub-agents are connected or none respond to `crewai.describe`.
