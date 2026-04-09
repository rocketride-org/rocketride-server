---
title: Perplexity
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Perplexity - RocketRide Documentation</title>
</head>

## What it does

Connects Perplexity AI Sonar models to your pipeline. Sonar models include real-time web search — responses are grounded in current web content rather than training data alone. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can also be used directly via lanes.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field   | Description                             |
| ------- | --------------------------------------- |
| Model   | Sonar model to use (see profiles below) |
| API Key | Perplexity AI API key                   |

## Profiles

| Profile             | Model                 | Context |
| ------------------- | --------------------- | ------- |
| Sonar _(default)_   | `sonar`               | 128,000 |
| Sonar Pro           | `sonar-pro`           | 200,000 |
| Sonar Reasoning     | `sonar-reasoning`     | 128,000 |
| Sonar Reasoning Pro | `sonar-reasoning-pro` | 128,000 |
| Sonar Deep Research | `sonar-deep-research` | 128,000 |

## Upstream docs

- [Perplexity AI documentation](https://docs.perplexity.ai/)
