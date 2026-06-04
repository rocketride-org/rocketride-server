---
title: Kimi (Moonshot)
date: 2026-06-04
sidebar_position: 1
---

<head>
  <title>Kimi (Moonshot) - RocketRide Documentation</title>
</head>

## What it does

Connects Moonshot AI's Kimi models to your pipeline via the Moonshot cloud API
(OpenAI-compatible). Used primarily as an `llm` invoke connection by agents and
other nodes that need an LLM. Can also be used directly via lanes.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field           | Description                                                      |
| --------------- | --------------------------------------------------------------- |
| Model           | Kimi/Moonshot model to use (see profiles below)                 |
| API Key         | Moonshot API key (`sk-` prefixed)                               |
| Server base URL | Moonshot endpoint (default `https://api.moonshot.ai/v1`; use `https://api.moonshot.cn/v1` for the China platform) |

## Profiles

| Profile             | Model            | Context     |
| ------------------- | ---------------- | ----------- |
| Kimi K2.6 _(default)_ | `kimi-k2.6`      | 256K tokens |
| Kimi K2.5           | `kimi-k2.5`      | 256K tokens |
| Moonshot v1 8K      | `moonshot-v1-8k`  | 8K tokens   |
| Moonshot v1 32K     | `moonshot-v1-32k` | 32K tokens  |
| Moonshot v1 128K    | `moonshot-v1-128k`| 128K tokens |

> Moonshot also offers `moonshot-v1-{8k,32k,128k}-vision-preview` image-input
> models. Those belong in a dedicated vision node (see the `llm_vision_*`
> nodes), not this text LLM node, which exposes only the `questions → answers`
> lane.

## Upstream docs

- [Moonshot AI / Kimi API documentation](https://platform.moonshot.ai/docs)
