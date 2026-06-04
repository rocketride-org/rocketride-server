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

| Profile                | Model                   | Context     |
| ---------------------- | ----------------------- | ----------- |
| Kimi K2 0905 _(default)_ | `kimi-k2-0905-preview`  | 256K tokens |
| Kimi K2 Turbo          | `kimi-k2-turbo-preview` | 256K tokens |
| Kimi K2 0711           | `kimi-k2-0711-preview`  | 128K tokens |
| Kimi Latest            | `kimi-latest`           | 128K tokens |
| Kimi Thinking          | `kimi-thinking-preview` | 128K tokens |
| Moonshot v1 8K         | `moonshot-v1-8k`        | 8K tokens   |
| Moonshot v1 32K        | `moonshot-v1-32k`       | 32K tokens  |
| Moonshot v1 128K       | `moonshot-v1-128k`      | 128K tokens |

## Upstream docs

- [Moonshot AI / Kimi API documentation](https://platform.moonshot.ai/docs)
