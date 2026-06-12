---
title: LlamaIndex
date: 2026-06-11
sidebar_position: 3
---

## What it does

Single-agent node using LlamaIndex's ReAct loop. Receives a question, reasons step by step selecting tools, and emits an answer.

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
| Instructions      | Additional instructions prepended to the agent's first turn          |

## Tool calling

The agent's LLM invocation channel returns text, so this node drives LlamaIndex's **ReAct loop** directly: the model emits `Thought / Action / Action Input` (or a final `Answer`) as text, parsed each turn. Works with any LLM that follows the ReAct format, without native function-calling. The agent still reaches multimodal capabilities (OCR, transcription, image embedding, etc.) by invoking those as tools. Up to 10 iterations.

## Using as a tool

Exposes itself as `<nodeId>.run_agent` so parent agents can delegate to it in hierarchical pipelines.

## Upstream docs

- [LlamaIndex agents](https://docs.llamaindex.ai/en/stable/understanding/agent/)
