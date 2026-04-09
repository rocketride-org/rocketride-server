---
title: Amazon Bedrock
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Amazon Bedrock - RocketRide Documentation</title>
</head>

## What it does

Connects Amazon Bedrock-hosted models to your pipeline. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can also be used directly via lanes.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field          | Description                               |
| -------------- | ----------------------------------------- |
| Model          | Bedrock model to use (see profiles below) |
| AWS Access Key | AWS access key ID                         |
| AWS Secret Key | AWS secret access key                     |
| AWS Region     | AWS region (default `us-east-1`)          |

## Profiles

**Anthropic**

| Profile           | Model ID                                    | Context     |
| ----------------- | ------------------------------------------- | ----------- |
| Claude Sonnet 4.5 | `anthropic.claude-sonnet-4-5-20250929-v1:0` | 200K tokens |
| Claude Opus 4.5   | `anthropic.claude-opus-4-5-20251101-v1:0`   | 200K tokens |
| Claude Opus 4     | `anthropic.claude-opus-4-20250514-v1:0`     | 200K tokens |
| Claude Sonnet 3.7 | `anthropic.claude-3-7-sonnet-20250219-v1:0` | 200K tokens |
| Claude Haiku 4.5  | `anthropic.claude-haiku-4-5-20251001-v1:0`  | 200K tokens |
| Claude Haiku 3.5  | `anthropic.claude-3-5-haiku-20241022-v1:0`  | 200K tokens |

**Meta**

| Profile                       | Model ID                                 | Context     |
| ----------------------------- | ---------------------------------------- | ----------- |
| Llama 4 Scout 17B _(default)_ | `meta.llama4-scout-17b-instruct-v1:0`    | 3.5M tokens |
| Llama 4 Maverick 17B          | `meta.llama4-maverick-17b-instruct-v1:0` | 1M tokens   |
| Llama 3.3 70B Instruct        | `meta.llama3-3-70b-instruct-v1:0`        | 128K tokens |
| Llama 3.2 90B Vision          | `meta.llama3-2-90b-instruct-v1:0`        | 128K tokens |
| Llama 3.2 11B Vision          | `meta.llama3-2-11b-instruct-v1:0`        | 128K tokens |
| Llama 3.2 3B Instruct         | `meta.llama3-2-3b-instruct-v1:0`         | 128K tokens |
| Llama 3.2 1B Instruct         | `meta.llama3-2-1b-instruct-v1:0`         | 128K tokens |
| Llama 3.1 70B Instruct        | `meta.llama3-1-70b-instruct-v1:0`        | 128K tokens |
| Llama 3.1 8B Instruct         | `meta.llama3-1-8b-instruct-v1:0`         | 128K tokens |

**Amazon**

| Profile            | Model ID                       | Context   |
| ------------------ | ------------------------------ | --------- |
| Nova 2 Lite        | `amazon.nova-2-lite-v1:0`      | 1M tokens |
| Titan Text Express | `amazon.titan-text-express-v1` | 8K tokens |

**AI21**

| Profile         | Model ID                    | Context     |
| --------------- | --------------------------- | ----------- |
| Jamba 1.5 Large | `ai21.jamba-1-5-large-v1:0` | 256K tokens |
| Jamba 1.5 Mini  | `ai21.jamba-1-5-mini-v1:0`  | 256K tokens |

**Cohere**

| Profile    | Model ID                     | Context     |
| ---------- | ---------------------------- | ----------- |
| Command R+ | `cohere.command-r-plus-v1:0` | 128K tokens |
| Command R  | `cohere.command-r-v1:0`      | 128K tokens |

**Custom** — specify any Bedrock model ID and token limit directly.

## Upstream docs

- [Amazon Bedrock documentation](https://docs.aws.amazon.com/bedrock/)
- [Bedrock model IDs](https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html)
