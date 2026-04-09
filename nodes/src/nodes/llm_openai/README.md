---
title: OpenAI
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>OpenAI - RocketRide Documentation</title>
</head>

## What it does

Connects OpenAI GPT models to your pipeline. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can also be used directly via lanes.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field   | Description                           |
| ------- | ------------------------------------- |
| Model   | GPT model to use (see profiles below) |
| API Key | OpenAI API key                        |

## Profiles

| Profile             | Model              | Context      |
| ------------------- | ------------------ | ------------ |
| GPT-5.2 _(default)_ | `gpt-5.2`          | 400,000      |
| GPT-5.4 Pro         | `gpt-5.4-pro`      | 1,050,000    |
| GPT-5.4             | `gpt-5.4`          | 1,050,000    |
| GPT-5.4-mini        | `gpt-5.4-mini`     | 400,000      |
| GPT-5.4-nano        | `gpt-5.4-nano`     | 400,000      |
| GPT-5.1             | `gpt-5.1`          | 400,000      |
| GPT-5               | `gpt-5`            | 400,000      |
| GPT-5-mini          | `gpt-5-mini`       | 400,000      |
| GPT-5-nano          | `gpt-5-nano`       | 400,000      |
| GPT-4o              | `gpt-4o`           | 128,000      |
| GPT-4o-mini         | `gpt-4o-mini`      | 128,000      |
| Custom              | _(user-specified)_ | configurable |

## Upstream docs

- [OpenAI API documentation](https://platform.openai.com/docs/api-reference)
