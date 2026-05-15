---
title: VertexAI (Personal)
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>VertexAI (Personal) - RocketRide Documentation</title>
</head>

## What it does

Connects Google Cloud Vertex AI models to your pipeline using Google OAuth. Supports Gemini, Claude, Gemma, Llama, and DeepSeek models hosted on Vertex AI. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can also be used directly via lanes.

Authenticates via your personal Google account. For service account (enterprise) authentication, use [VertexAI (Enterprise)](../vertex-enterprise/).

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field          | Description                                 |
| -------------- | ------------------------------------------- |
| Google Account | Sign in with Google OAuth                   |
| Model          | Vertex AI model to use (see profiles below) |
| Project        | GCP project ID                              |
| Location       | GCP region (pre-set per profile, editable)  |

## Profiles

**Gemini**

| Profile                      | Model                   | Context   |
| ---------------------------- | ----------------------- | --------- |
| Gemini 2.5 Flash _(default)_ | `gemini-2.5-flash`      | 1,048,576 |
| Gemini 3 Pro                 | `gemini-3-pro`          | 1,048,576 |
| Gemini 2.5 Pro               | `gemini-2.5-pro`        | 1,048,576 |
| Gemini 2.5 Flash Lite        | `gemini-2.5-flash-lite` | 1,048,576 |
| Gemini 2.0 Flash             | `gemini-2.0-flash`      | 1,048,576 |
| Gemini 2.0 Flash Lite        | `gemini-2.0-flash-lite` | 1,048,576 |

**Claude**

| Profile           | Model                        | Context |
| ----------------- | ---------------------------- | ------- |
| Claude Opus 4.5   | `claude-opus-4-5@20251101`   | 200,000 |
| Claude Sonnet 4.5 | `claude-sonnet-4-5@20250929` | 200,000 |
| Claude Haiku 4.5  | `claude-haiku-4-5@20251001`  | 200,000 |
| Claude 3.5 Haiku  | `claude-3-5-haiku@20241022`  | 200,000 |

**Gemma**

| Profile     | Model         | Context |
| ----------- | ------------- | ------- |
| Gemma 3 27B | `gemma-3-27b` | 131,072 |
| Gemma 3 12B | `gemma-3-12b` | 131,072 |
| Gemma 3 4B  | `gemma-3-4b`  | 131,072 |
| Gemma 3 1B  | `gemma-3-1b`  | 131,072 |

**Llama**

| Profile          | Model                                     | Context   |
| ---------------- | ----------------------------------------- | --------- |
| Llama 4 Scout    | `llama-4-scout-17b-16e-instruct-maas`     | 1,310,720 |
| Llama 4 Maverick | `llama-4-maverick-17b-128e-instruct-maas` | 524,288   |
| Llama 3.3        | `llama-3.3-70b-instruct-maas`             | 128,000   |
| Llama 3.2 90B    | `llama-3.2-90b-vision-instruct-maas`      | 128,000   |
| Llama 3.1 405B   | `llama-3.1-405b`                          | 128,000   |
| Llama 3.1 70B    | `llama-3.1-70b`                           | 128,000   |
| Llama 3.1 8B     | `llama-3.1-8b`                            | 128,000   |

**Other**

| Profile     | Model                   | Context |
| ----------- | ----------------------- | ------- |
| DeepSeek R1 | `deepseek-r1-0528-maas` | 163,840 |

**Custom** — specify any Vertex AI model ID, token limit, project, and location directly.

## Upstream docs

- [Vertex AI documentation](https://cloud.google.com/vertex-ai/docs)
- [Vertex AI model garden](https://cloud.google.com/vertex-ai/generative-ai/docs/model-garden/explore-models)
