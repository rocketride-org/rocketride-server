---
title: Memory (Internal)
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Memory (Internal) - RocketRide Documentation</title>
</head>

## What it does

The backing memory store for the [RocketRide Wave agent](../agent_rocketride/). Only wireable to that agent — connect it via the `memory` invoke channel.

Each wave's tool results are stored here under auto-assigned keys (e.g. `wave-0.r0`). The agent injects structural summaries (field names, array lengths, sample values) into the planning prompt rather than raw data, keeping context lean. The LLM uses `memory.peek` to extract specific values on demand via JMESPath, and signals `remove: [...]` to evict keys it no longer needs.

Memory is cleared at the end of each pipeline run.

## Tools

| Tool           | Description                                               |
| -------------- | --------------------------------------------------------- |
| `memory.put`   | Store a value under a key                                 |
| `memory.get`   | Retrieve the full stored value for a key                  |
| `memory.list`  | List all keys currently in memory                         |
| `memory.clear` | Clear a specific key, or omit the key to clear everything |

## Configuration

None.
