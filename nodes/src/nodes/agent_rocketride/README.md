---
title: RocketRide Wave
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>RocketRide Wave - RocketRide Documentation</title>
</head>

:::note
This node is **experimental**.
:::

## What it does

RocketRide's native wave-planning agent. Each iteration the LLM plans a batch of tool calls, all tools in the batch run in parallel, results are stored in keyed memory, and the loop repeats until the LLM signals `done` or `max_waves` is reached.

**Lanes:** `questions` → `answers`

## Connections

| Channel  | Required    | Description                    |
| -------- | ----------- | ------------------------------ |
| `llm`    | yes (max 1) | LLM for planning and synthesis |
| `tool`   | no          | Tools available to the agent   |
| `memory` | yes (max 1) | Keyed memory store             |

The `memory` channel is required — connect a memory node before running.

## Configuration

| Field             | Default | Description                                                            |
| ----------------- | ------- | ---------------------------------------------------------------------- |
| Agent Description | —       | What this agent does — used by parent agents to select and invoke it   |
| Instructions      | —       | Additional instructions injected into the planning prompt each wave    |
| Max Waves         | `10`    | Maximum planning iterations before the synthesis fallback fires (1–50) |

## How the wave loop works

1. **Plan** — LLM receives all tool descriptions, prior wave summaries, and scratch notes. Responds with either `tool_calls` (an array of parallel calls to execute) or `done: true` with a final answer.
2. **Execute** — all tool calls in the batch run concurrently (max 8 threads, 120s timeout each). Results are stored in memory under keys like `wave-0.r0`.
3. **Summarize** — structural summaries (field names, array lengths, sample values) are injected into the next prompt. Raw data stays in memory.
4. **Repeat** until `done: true` or `max_waves` is hit. If the wave limit is reached, a synthesis fallback asks the LLM to produce a best-effort answer from everything gathered.

## Memory system

The agent uses a two-level memory model to stay token-efficient:

- **Structural summaries** — always visible in the planning prompt. Show data shape without loading raw values into context.
- **`memory.peek`** — built-in tool the LLM calls on demand to extract specific values via JMESPath (e.g. `rows[0:5].city`). Arrays are capped at 50 items per call; large raw values can be paged with `offset`/`length`.
- **`{{memory.ref:key}}`** — embeds the stored value by key at render time.
- **`{{memory.ref:key:format}}`** — renders bulk data in a specific format (`csv`, `json`, or `table`) without loading it into context.
- **`{{memory.ref:key:format:path}}`** — extracts a nested path from the stored value before formatting (e.g. `results.rows`). Arrays can be paged with `offset`/`length`. All variants are resolved by the executor at render time.

The LLM maintains a **scratch** field — persistent working notes (memory keys, extracted values, intermediate calculations) that carry forward across waves. When the LLM is done with a result key it signals `remove: ["wave-0.r0"]` to evict it, keeping the planning prompt lean for long-running tasks.
