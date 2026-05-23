---
title: MiniMax
date: 2026-05-21
sidebar_position: 1
---

<head>
  <title>MiniMax - RocketRide Documentation</title>
</head>

## What it does

Connects [MiniMax](https://www.minimax.io/) models to your pipeline — either via the MiniMax cloud API or via a self-hosted OpenAI-compatible server (vLLM, SGLang, MLX, or Ollama). Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can also be used directly via lanes.

The MiniMax API is OpenAI-compatible, so this node uses the OpenAI SDK / `langchain-openai` client pointed at the configured base URL.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field           | Description                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model           | MiniMax model to use (see profiles below)                                                                                                                                  |
| API Key         | MiniMax API key (cloud profiles only — local profiles don't require one; the node passes a dummy token)                                                                    |
| Server base URL | Endpoint URL — `https://api.minimax.io/v1` for cloud (international), `https://api.minimaxi.com/v1` for China, `http://localhost:8000/v1` for vLLM/SGLang, `http://localhost:8080/v1` for MLX, or `http://localhost:11434/v1` for Ollama (Custom and Local profiles only) |

## Profiles

**Cloud**

| Profile                | Model                     | Context     |
| ---------------------- | ------------------------- | ----------- |
| MiniMax M2 _(default)_ | `MiniMax-M2`              | 200K tokens |
| MiniMax M2.1           | `MiniMax-M2.1`            | 200K tokens |
| MiniMax M2.1 Highspeed | `MiniMax-M2.1-highspeed`  | 200K tokens |
| MiniMax M2.5           | `MiniMax-M2.5`            | 200K tokens |
| MiniMax M2.5 Highspeed | `MiniMax-M2.5-highspeed`  | 200K tokens |
| MiniMax M2.7           | `MiniMax-M2.7`            | 200K tokens |
| MiniMax M2.7 Highspeed | `MiniMax-M2.7-highspeed`  | 200K tokens |
| Custom Model           | User-defined              | User-defined |

The cloud catalogue above is what `models.list()` returns as of 2026-05-21. The `-highspeed` variants are MiniMax's faster/cheaper tier of the same generation.

**Local deploy**

Defaults target vLLM / SGLang on `http://localhost:8000/v1` with the HuggingFace model path — that's the configuration MiniMax itself documents in its [Local Deployment guide](https://platform.minimax.io/docs/guides/local-deploy).

| Profile             | Model (HF path)            | Server base URL (default)     | Context     |
| ------------------- | -------------------------- | ----------------------------- | ----------- |
| MiniMax M2 (Local)  | `MiniMaxAI/MiniMax-M2`     | `http://localhost:8000/v1`    | 200K tokens |
| MiniMax M2.5 (Local)| `MiniMaxAI/MiniMax-M2.5`   | `http://localhost:8000/v1`    | 200K tokens |
| MiniMax M2.7 (Local)| `MiniMaxAI/MiniMax-M2.7`   | `http://localhost:8000/v1`    | 200K tokens |

**Hardware notes.** MiniMax's open-weight models are MIT-licensed but large — M2 / M2.5 / M2.7 are all 230B-parameter MoE architectures (~10B active per token). The recommended local setups are:

- **Linux + GPU (≥96 GB VRAM total)** — vLLM or SGLang on port `8000`. Use the HF model path as shown above.
- **Apple Silicon Mac Studio (≥128 GB unified memory)** — MLX on port `8080`. Edit the Server base URL to `http://localhost:8080/v1` and change the model to a quantized MLX build, e.g. `mlx-community/MiniMax-M2.7-4bit`.
- **Ollama (<128 GB systems, fallback only)** — listed in MiniMax's docs as an alternative for low-memory setups. Edit the Server base URL to `http://localhost:11434/v1` and the model to whatever tag you pulled (verify with `ollama pull <tag>` before use; tags may not yet exist for every M2 variant).

These models will not fit on a typical laptop without aggressive quantization. M2.7 is the only variant whose local-deploy steps are formally documented today; the M2 and M2.5 entries are scaffolded against the same HuggingFace naming so they work as soon as their upstream guides land. M2.7 is a reasoning model — its responses split `message.content` (final answer) from `message.reasoning_content` (chain of thought), so set generous output token budgets (`max_tokens ≥ ~200`) even for short prompts.

## Upstream docs

- [MiniMax platform documentation](https://platform.minimaxi.com/document/)
- [MiniMax API reference (OpenAI-compatible)](https://www.minimax.io/platform/document/ChatCompletion)
- [MiniMax local deployment guide](https://platform.minimax.io/docs/guides/local-deploy)
