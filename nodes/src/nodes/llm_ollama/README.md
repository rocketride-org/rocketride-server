---
title: Ollama
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Ollama - RocketRide Documentation</title>
</head>

## What it does

Connects locally-hosted Ollama models to your pipeline. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can also be used directly via lanes. No API key required — models run on your own hardware.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field           | Description                                           |
| --------------- | ----------------------------------------------------- |
| Model           | Ollama model to use (see profiles below)              |
| Server base URL | Ollama endpoint (default `http://localhost:11434/v1`) |

## Profiles

**Llama**

| Profile               | Model             | Context    |
| --------------------- | ----------------- | ---------- |
| Llama 4 Latest        | `llama4:latest`   | 10,000,000 |
| Llama 3.3 _(default)_ | `llama3.3:latest` | 128,000    |
| Llama 3.1 405B        | `llama3.1:405b`   | 128,000    |
| Llama 3.1 70B         | `llama3.1:70b`    | 128,000    |
| Llama 3.1 8B          | `llama3.1:8b`     | 128,000    |
| Llama 3.2 3B          | `llama3.2`        | 128,000    |
| Llama 3.2 1B          | `llama3.2:1b`     | 128,000    |

**Qwen**

| Profile       | Model          | Context |
| ------------- | -------------- | ------- |
| Qwen 3 Latest | `qwen3:latest` | 128,000 |
| Qwen 2.5 72B  | `qwen2.5:72b`  | 128,000 |
| Qwen 2.5 32B  | `qwen2.5:32b`  | 128,000 |
| Qwen 2.5 14B  | `qwen2.5:14b`  | 128,000 |
| Qwen 2.5 7B   | `qwen2.5`      | 128,000 |
| Qwen 2.5 3B   | `qwen2.5:3b`   | 128,000 |
| Qwen 2.5 1.5B | `qwen2.5:1.5b` | 128,000 |
| Qwen 2.5 0.5B | `qwen2.5:0.5b` | 128,000 |

**DeepSeek**

| Profile          | Model              | Context |
| ---------------- | ------------------ | ------- |
| DeepSeek R1 671B | `deepseek-r1:671b` | 128,000 |
| DeepSeek R1 32B  | `deepseek-r1:32b`  | 128,000 |
| DeepSeek R1 14B  | `deepseek-r1:14b`  | 128,000 |
| DeepSeek R1 7B   | `deepseek-r1:7b`   | 128,000 |
| DeepSeek R1 1.5B | `deepseek-r1:1.5b` | 128,000 |

**Other**

| Profile    | Model     | Context |
| ---------- | --------- | ------- |
| Phi 4 14B  | `phi4`    | 16,000  |
| Mistral 7B | `mistral` | 32,000  |

**Custom** — specify any Ollama model tag, token limit, and server URL directly.

## Upstream docs

- [Ollama documentation](https://docs.ollama.com/)
- [Ollama model library](https://ollama.com/library)
