---
title: Qwen
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Qwen - RocketRide Documentation</title>
</head>

## What it does

Connects Alibaba Cloud Qwen models to your pipeline via the DashScope API. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can also be used directly via lanes.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field   | Description                             |
| ------- | --------------------------------------- |
| Model   | Qwen model to use (see profiles below)  |
| Region  | DashScope regional endpoint (see below) |
| API Key | DashScope API key                       |

### Regions

API keys are not interchangeable between regions.

| Value          | Region             |
| -------------- | ------------------ |
| `us`           | US (Virginia)      |
| `intl`         | Singapore          |
| `cn`           | China (Beijing)    |
| `cn-hongkong`  | Hong Kong          |
| `eu-central-1` | Europe (Frankfurt) |

US deployments require the `-us` model suffix (e.g., `qwen3.5-flash-us`).

## Profiles

| Profile                | Model           | Context   |
| ---------------------- | --------------- | --------- |
| Qwen Flash _(default)_ | `qwen3.5-flash` | 1,000,000 |
| Qwen Plus              | `qwen3.5-plus`  | 1,000,000 |

## Upstream docs

- [DashScope API reference](https://help.aliyun.com/zh/dashscope/)
