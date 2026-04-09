---
title: IBM Watson
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>IBM Watson - RocketRide Documentation</title>
</head>

## What it does

Connects IBM WatsonX foundation models to your pipeline via the IBM Cloud API. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can also be used directly via lanes.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field      | Description                                               |
| ---------- | --------------------------------------------------------- |
| API Key    | IBM Cloud API key                                         |
| Location   | IBM Cloud region (see below)                              |
| Model ID   | WatsonX model ID — specified directly, no preset profiles |
| Project ID | IBM WatsonX project ID                                    |

### Locations

| Value      | Region        |
| ---------- | ------------- |
| `us-south` | Dallas        |
| `us-east`  | Washington DC |
| `eu-gb`    | London        |
| `eu-de`    | Frankfurt     |
| `eu-es`    | Madrid        |
| `jp-tok`   | Tokyo         |
| `jp-osa`   | Osaka         |
| `au-syd`   | Sydney        |
| `ca-tor`   | Toronto       |
| `br-sao`   | São Paulo     |

There are no preset profiles — enter any valid WatsonX model ID directly.

## Upstream docs

- [IBM WatsonX foundation models](https://www.ibm.com/products/watsonx-ai/foundation-models)
- [IBM WatsonX model IDs](https://dataplatform.cloud.ibm.com/docs/content/wsj/analyze-data/fm-models.html)
