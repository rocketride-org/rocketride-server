---
title: GMI Cloud
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>GMI Cloud - RocketRide Documentation</title>
</head>

## What it does

Connects GMI Cloud-hosted models to your pipeline via an OpenAI-compatible API. GMI Cloud runs 100+ open-weight and proxied proprietary models on H100/H200 infrastructure. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can also be used directly via lanes.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field        | Description                                                            |
| ------------ | ---------------------------------------------------------------------- |
| Model        | Model to use (see profiles below)                                      |
| API Key      | GMI Cloud API key                                                      |
| Endpoint URL | Deployment endpoint — required for deploy-on-demand models (see below) |

## Model tiers

GMI Cloud has two tiers:

**Shared (always-on)** — available immediately, API key only:

| Profile                 | Model                                 | Context |
| ----------------------- | ------------------------------------- | ------- |
| DeepSeek V3 _(default)_ | `deepseek-ai/DeepSeek-V3-0324`        | 163,840 |
| DeepSeek V3.2           | `deepseek-ai/DeepSeek-V3.2`           | 163,840 |
| DeepSeek R1             | `deepseek-ai/DeepSeek-R1`             | 131,072 |
| DeepSeek Prover V2      | `deepseek-ai/DeepSeek-Prover-V2-671B` | 131,072 |
| GPT-5.2                 | `openai/gpt-5.2`                      | 128,000 |
| GPT-5.1                 | `openai/gpt-5.1`                      | 128,000 |
| GPT-5                   | `openai/gpt-5`                        | 128,000 |
| GPT-4o                  | `openai/gpt-4o`                       | 128,000 |
| Claude Opus 4.5         | `anthropic/claude-opus-4.5`           | 200,000 |
| Claude Sonnet 4.5       | `anthropic/claude-sonnet-4.5`         | 200,000 |
| Gemini 3 Pro            | `google/gemini-3-pro-preview`         | 128,000 |
| Gemini 3 Flash          | `google/gemini-3-flash-preview`       | 128,000 |

**Deploy-on-demand** — deploy first at [console.gmicloud.ai](https://console.gmicloud.ai), then paste the provided endpoint URL into the **Endpoint URL** field:

| Profile                  | Model                                               | Context   |
| ------------------------ | --------------------------------------------------- | --------- |
| Llama 4 Scout            | `meta-llama/Llama-4-Scout-17B-16E-Instruct`         | 1,048,576 |
| Llama 4 Maverick         | `meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 1,048,576 |
| Qwen3 235B               | `Qwen/Qwen3-235B-A22B-FP8`                          | 131,072   |
| Qwen3 32B                | `Qwen/Qwen3-32B-FP8`                                | 131,072   |
| Qwen3 30B                | `Qwen/Qwen3-30B-A3B`                                | 131,072   |
| Qwen3 Coder 480B         | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8`           | 131,072   |
| DeepSeek R1 Distill 32B  | `deepseek-ai/DeepSeek-R1-Distill-Qwen-32B`          | 131,072   |
| DeepSeek R1 Distill 1.5B | `deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B`         | 131,072   |

**Custom** — specify any GMI Cloud model ID, token limit, and endpoint URL directly.

## Upstream docs

- [GMI Cloud model catalogue](https://www.gmicloud.ai/models)
- [GMI Cloud console](https://console.gmicloud.ai)
