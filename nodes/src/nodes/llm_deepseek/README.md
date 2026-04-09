---
title: DeepSeek
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>DeepSeek - RocketRide Documentation</title>
</head>

## What it does

Connects DeepSeek models to your pipeline — either via the DeepSeek cloud API or locally through Ollama. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can also be used directly via lanes.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field           | Description                                                                |
| --------------- | -------------------------------------------------------------------------- |
| Model           | DeepSeek model to use (see profiles below)                                 |
| API Key         | DeepSeek API key (cloud profiles only)                                     |
| Server base URL | Ollama endpoint (local profiles only, default `http://localhost:11434/v1`) |

## Profiles

**Cloud**

| Profile                    | Model               | Context     |
| -------------------------- | ------------------- | ----------- |
| Cloud Reasoner _(default)_ | `deepseek-reasoner` | 128K tokens |
| Cloud Chat                 | `deepseek-chat`     | 128K tokens |

**Local via Ollama**

| Profile          | Model              | Context     |
| ---------------- | ------------------ | ----------- |
| DeepSeek R1 1.5B | `deepseek-r1:1.5b` | 128K tokens |
| DeepSeek R1 7B   | `deepseek-r1:7b`   | 128K tokens |
| DeepSeek R1 8B   | `deepseek-r1:8b`   | 128K tokens |
| DeepSeek R1 14B  | `deepseek-r1:14b`  | 128K tokens |
| DeepSeek R1 32B  | `deepseek-r1:32b`  | 128K tokens |
| DeepSeek R1 70B  | `deepseek-r1:70b`  | 128K tokens |
| DeepSeek R1 671B | `deepseek-r1:671b` | 128K tokens |
| DeepSeek V3      | `deepseek-v3`      | 128K tokens |

## Upstream docs

- [DeepSeek API documentation](https://platform.deepseek.com/docs)
