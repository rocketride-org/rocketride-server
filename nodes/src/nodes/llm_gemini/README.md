---
title: Gemini
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Gemini - RocketRide Documentation</title>
</head>

## What it does

Connects Google Gemini models to your pipeline. Used primarily as an `llm` invoke connection by agents and other nodes that need an LLM. Can also be used directly via lanes.

**Lanes:**

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

| Field   | Description                              |
| ------- | ---------------------------------------- |
| Model   | Gemini model to use (see profiles below) |
| API Key | Google AI Studio API key                 |

## Profiles

| Profile                    | Model                                   | Context      | Max output   |
| -------------------------- | --------------------------------------- | ------------ | ------------ |
| Gemini 3.1 Pro _(default)_ | `models/gemini-3.1-pro-preview`         | 1,114,112    | 65,536       |
| Gemini 3.1 Flash Lite      | `models/gemini-3.1-flash-lite-preview`  | 1,114,112    | 65,536       |
| Gemini 3.1 Flash Image     | `models/gemini-3.1-flash-image-preview` | 163,840      | 32,768       |
| Gemini 3 Flash             | `models/gemini-3-flash-preview`         | 1,064,000    | 65,536       |
| Gemini 3 Pro Image         | `models/gemini-3-pro-image-preview`     | 98,304       | 32,768       |
| Gemini 2.5 Pro             | `models/gemini-2.5-pro`                 | 1,114,112    | 65,536       |
| Gemini 2.5 Flash           | `models/gemini-2.5-flash`               | 1,114,112    | 65,536       |
| Gemini 2.5 Flash Lite      | `models/gemini-2.5-flash-lite`          | 1,114,112    | 65,536       |
| Gemini 2.5 Flash Image     | `models/gemini-2.5-flash-image`         | 98,304       | 32,768       |
| Custom                     | _(user-specified)_                      | configurable | configurable |

Profiles marked **Image** support image generation output. Deprecated profiles (Gemini 3 Pro, 2.0 Flash, 2.0 Flash Lite) are hidden — use their replacements above.

## Upstream docs

- [Gemini API documentation](https://ai.google.dev/docs/gemini_api_overview)
