---
title: MiniMax
date: 2026-05-21
sidebar_position: 1
---

<head>
  <title>MiniMax - RocketRide Documentation</title>
</head>

## What it does

Connects [MiniMax](https://www.minimax.io/) models to your pipeline via the MiniMax cloud API. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can also be used directly via lanes.

The MiniMax API is OpenAI-compatible, so this node uses the OpenAI SDK / `langchain-openai` client pointed at the MiniMax base URL.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field           | Description                                                          |
| --------------- | -------------------------------------------------------------------- |
| Model           | MiniMax model to use (see profiles below)                            |
| API Key         | MiniMax API key                                                      |
| Server base URL | MiniMax endpoint (default `https://api.minimax.io/v1`; custom only)  |

## Profiles

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

The catalog above is what `models.list()` returns as of 2026-05-21. The `-highspeed` variants
are MiniMax's faster/cheaper tier of the same generation.

## Upstream docs

- [MiniMax platform documentation](https://platform.minimaxi.com/document/)
- [MiniMax API reference (OpenAI-compatible)](https://www.minimax.io/platform/document/ChatCompletion)
