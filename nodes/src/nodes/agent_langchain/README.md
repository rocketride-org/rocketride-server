---
title: LangChain
date: 2026-03-02
sidebar_position: 2
---

<head>
  <title>LangChain - RocketRide Documentation</title>
</head>

## What it does

Single-agent node using LangChain's `create_agent`. Receives a question, runs a tool-calling agent loop, and emits an answer.

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

RocketRide's LLM channel is text-only, so this node uses a **JSON envelope protocol** — the LLM is instructed to output `{"type":"tool_call","name":"...","args":{...}}` or `{"type":"final","content":"..."}` on every turn. This means it works with any LLM that can follow JSON instructions, not only those with native function-calling support. Up to 3 retries are attempted when the LLM produces malformed JSON.

## Using as a tool

Exposes itself as `<nodeId>.run_agent` so parent agents can delegate to it in hierarchical pipelines.

## Upstream docs

- [LangChain agents](https://python.langchain.com/docs/concepts/agents)
