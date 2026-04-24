---
title: xAI
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>xAI - RocketRide Documentation</title>
</head>

## What it does

Connects xAI Grok models to your pipeline. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can also be used directly via lanes.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field   | Description                            |
| ------- | -------------------------------------- |
| Model   | Grok model to use (see profiles below) |
| API Key | xAI API key                            |

## Profiles

| Profile                     | Model                         | Context      |
| --------------------------- | ----------------------------- | ------------ |
| Grok 3 _(default)_          | `grok-3`                      | 131,072      |
| Grok 3 Mini                 | `grok-3-mini`                 | 131,072      |
| Grok 4                      | `grok-4-0709`                 | 256,000      |
| Grok 4 Fast                 | `grok-4-fast-reasoning`       | 2,000,000    |
| Grok 4 Fast Non-Reasoning   | `grok-4-fast-non-reasoning`   | 2,000,000    |
| Grok 4.1 Fast               | `grok-4-1-fast-reasoning`     | 2,000,000    |
| Grok 4.1 Fast Non-Reasoning | `grok-4-1-fast-non-reasoning` | 2,000,000    |
| Grok Code Fast 1            | `grok-code-fast-1`            | 256,000      |
| Custom                      | _(user-specified)_            | configurable |

## Upstream docs

- [xAI API documentation](https://docs.x.ai/docs/overview)
