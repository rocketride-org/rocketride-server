---
title: Nebius
date: 2026-06-01
sidebar_position: 1
---

<head>
  <title>Nebius - RocketRide Documentation</title>
</head>

## What it does

Connects Nebius Token Factory-hosted models to your pipeline via an OpenAI-compatible API. The base URL is fixed at `https://api.tokenfactory.nebius.com/v1/` — no endpoint configuration needed. Used primarily as an `llm` invoke connection by agents (including Nebius Agentic Search) and other nodes that need an LLM. Can also be used directly via lanes.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field   | Description                                     |
| ------- | ----------------------------------------------- |
| Model   | Model profile or custom model ID (see below)    |
| API Key | Nebius Token Factory API key (`NEBIUS_API_KEY`) |

The API key can be supplied via the node's **API Key** field or the `NEBIUS_API_KEY` environment variable.

## Model profiles

| Profile                    | Model ID                                | Context |
| -------------------------- | --------------------------------------- | ------- |
| Llama 3.3 70B _(default)_  | `meta-llama/Llama-3.3-70B-Instruct`    | 131,072 |
| Qwen3 235B                 | `Qwen/Qwen3-235B-A22B`                 | 131,072 |
| DeepSeek V3                | `deepseek-ai/DeepSeek-V3`              | 131,072 |
| Custom                     | any Token Factory model ID             | 131,072 |

**Custom** — specify any Nebius Token Factory model ID and token limit directly.

## Upstream docs

- [Nebius Token Factory model catalogue](https://tokenfactory.nebius.com/models)
- [Nebius AI documentation](https://docs.nebius.com)
