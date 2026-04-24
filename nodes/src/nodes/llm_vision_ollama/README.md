---
title: Ollama Vision
date: 2026-04-08
sidebar_position: 1
---

## What it does

Sends images to locally-hosted Ollama vision models and returns text analysis. No API key required — models run on your own hardware. Accepts either a single image or a stream of image documents (e.g. from the frame grabber). Metadata such as frame number and timestamp is preserved on the `documents` output.

**Lanes:**

| Lane in     | Lane out    | Description                                                                    |
| ----------- | ----------- | ------------------------------------------------------------------------------ |
| `image`     | `text`      | Analyze a single image, receive text                                           |
| `documents` | `documents` | Analyze image documents, return text analysis with original metadata preserved |

## Configuration

| Field               | Description                                             |
| ------------------- | ------------------------------------------------------- |
| Model               | Vision model to use (see profiles below)                |
| Server base URL     | Ollama endpoint (default `http://localhost:11434/v1`)   |
| System Instructions | Define the model's role and behavior for image analysis |
| Analysis Prompt     | Describe what to analyze or extract from the image      |

## Profiles

| Profile                          | Model                 | Context      |
| -------------------------------- | --------------------- | ------------ |
| Llama 3.2 Vision 11B _(default)_ | `llama3.2-vision:11b` | 128,000      |
| Llama 3.2 Vision 90B             | `llama3.2-vision:90b` | 128,000      |
| Qwen 2.5 VL 7B                   | `qwen2.5vl:7b`        | 128,000      |
| Qwen 2.5 VL 3B                   | `qwen2.5vl:3b`        | 128,000      |
| LLaVA 7B                         | `llava:7b`            | 32,768       |
| LLaVA 13B                        | `llava:13b`           | 4,096        |
| LLaVA 34B                        | `llava:34b`           | 4,096        |
| MiniCPM-V                        | `minicpm-v`           | 8,192        |
| Moondream 2                      | `moondream`           | 2,048        |
| Custom                           | _(user-specified)_    | configurable |

## Upstream docs

- [Ollama model library](https://ollama.com/library)
