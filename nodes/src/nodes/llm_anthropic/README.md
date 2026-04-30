---
title: Anthropic
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Anthropic - RocketRide Documentation</title>
</head>

## What it does

Connects Anthropic's Claude models to your pipeline. Used primarily as an `llm` invoke connection by agents, vector stores, database nodes, and other nodes that need an LLM. Can also be used directly in a pipeline via lanes.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field   | Description                              |
| ------- | ---------------------------------------- |
| Model   | Claude model to use (see profiles below) |
| API Key | Anthropic API key                        |

## Profiles

| Profile                       | Model ID            | Context                          |
| ----------------------------- | ------------------- | -------------------------------- |
| Claude Sonnet 4.6 _(default)_ | `claude-sonnet-4-6` | 200K tokens                      |
| Claude Opus 4.6               | `claude-opus-4-6`   | 200K tokens                      |
| Claude Sonnet 4.5             | `claude-sonnet-4-5` | 200K tokens                      |
| Claude Opus 4.5               | `claude-opus-4-5`   | 200K tokens                      |
| Claude Haiku 4.5              | `claude-haiku-4-5`  | 200K tokens                      |
| Custom                        | _(user-specified)_  | Specify model ID and token limit |

## Upstream docs

- [Anthropic API documentation](https://docs.anthropic.com/claude/docs)
