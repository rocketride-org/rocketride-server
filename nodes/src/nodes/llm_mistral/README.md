---
title: Mistral AI
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Mistral AI - RocketRide Documentation</title>
</head>

## What it does

Connects Mistral AI models to your pipeline. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can also be used directly via lanes.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field   | Description                               |
| ------- | ----------------------------------------- |
| Model   | Mistral model to use (see profiles below) |
| API Key | Mistral AI API key                        |

## Profiles

**Flagship**

| Profile                     | Model                 | Context |
| --------------------------- | --------------------- | ------- |
| Mistral Large 3 _(default)_ | `mistral-large-2512`  | 256,000 |
| Mistral Medium 3.1          | `mistral-medium-2508` | 131,072 |
| Mistral Small 3.2           | `mistral-small-2506`  | 131,072 |

**Reasoning**

| Profile              | Model                   | Context |
| -------------------- | ----------------------- | ------- |
| Magistral Medium 1.2 | `magistral-medium-2509` | 40,960  |
| Magistral Small 1.2  | `magistral-small-2509`  | 40,960  |

**Code**

| Profile             | Model                  | Context |
| ------------------- | ---------------------- | ------- |
| Codestral           | `codestral-2508`       | 262,144 |
| Devstral Medium 1.0 | `devstral-medium-2507` | 131,072 |
| Devstral Small 1.1  | `devstral-small-2507`  | 131,072 |

**Edge**

| Profile         | Model                | Context |
| --------------- | -------------------- | ------- |
| Ministral 3 14B | `ministral-14b-2512` | 256,000 |
| Ministral 3 8B  | `ministral-8b-2512`  | 256,000 |
| Ministral 3 3B  | `ministral-3b-2512`  | 256,000 |

**Custom** — specify any Mistral model ID and token limit directly.

## Upstream docs

- [Mistral AI documentation](https://docs.mistral.ai/)
- [Mistral AI console](https://console.mistral.ai/)
