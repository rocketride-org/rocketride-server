---
title: Deep Agent
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Deep Agent - RocketRide Documentation</title>
</head>

## What it does

Agent node built on the [`deepagents`](https://github.com/NirDiamant/deep_agent) library (LangChain/LangGraph). Adds strategic planning, persistent state, and long-context management on top of a standard LangChain agent loop.

**Lanes:** `questions` → `answers`

## Connections

| Channel | Required | Description                  |
| ------- | -------- | ---------------------------- |
| `llm`   | yes      | LLM the agent thinks with    |
| `tool`  | no       | Tools available to the agent |

## Configuration

| Field             | Description                                                          |
| ----------------- | -------------------------------------------------------------------- |
| Agent Description | What this agent does — used by parent agents to select and invoke it |
| Instructions      | Additional instructions prepended to the agent's system prompt       |

## Tool calling

This node uses a **JSON envelope protocol** for tool calling — the host LLM is instructed to output either `{"type":"tool_call","name":"...","args":{...}}` or `{"type":"final","content":"..."}`. This means it works with any LLM that can follow JSON instructions, not only those with native function-calling support. Up to 3 retries are attempted when the LLM produces malformed JSON.

## Using as a tool

This node exposes itself as an invokable tool (`<nodeId>.run_agent`) so parent agents can delegate to it in hierarchical pipelines.
