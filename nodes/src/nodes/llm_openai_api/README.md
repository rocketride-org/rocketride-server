---
title: OpenAI-Compatible API
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>OpenAI-Compatible API - RocketRide Documentation</title>
</head>

## What it does

Connects any OpenAI-compatible API endpoint to your pipeline. Use this node for providers that implement the OpenAI API spec (Featherless, Together, Groq, LM Studio, and others) but don't have a dedicated RocketRide node. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can also be used directly via lanes.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field    | Description                                                          |
| -------- | -------------------------------------------------------------------- |
| Model    | Model ID as expected by the provider (e.g. `meta-llama/Llama-3-70b`) |
| Base URL | Provider API endpoint (e.g. `https://api.featherless.ai/v1`)         |
| Tokens   | Maximum context length in tokens                                     |
| API Key  | Provider API key                                                     |

There are no preset profiles — all fields are specified directly.
