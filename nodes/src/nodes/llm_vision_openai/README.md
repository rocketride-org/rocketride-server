---
title: OpenAI Vision
date: 2026-04-14
sidebar_position: 1
---

## What it does

Sends images to OpenAI vision-capable models and returns text analysis. Accepts either a single image or a stream of image documents (e.g. from the frame grabber). Metadata such as frame number and timestamp is preserved on the `documents` output.

**Lanes:**

| Lane in     | Lane out    | Description                                                                    |
| ----------- | ----------- | ------------------------------------------------------------------------------ |
| `image`     | `text`      | Analyze a single image, receive text                                           |
| `documents` | `documents` | Analyze image documents, return text analysis with original metadata preserved |

## Configuration

| Field               | Description                                             |
| ------------------- | ------------------------------------------------------- |
| Model               | Vision model to use (see profiles below)                |
| API Key             | OpenAI API key (starts with `sk-`)                      |
| System Instructions | Define the model's role and behavior for image analysis |
| Analysis Prompt     | Describe what you want to analyze or extract from image |

## Profiles

| Profile             | Model          | Context   |
| ------------------- | -------------- | --------- |
| GPT-4.1 _(default)_ | `gpt-4.1`      | 1,047,576 |
| GPT-4.1-mini        | `gpt-4.1-mini` | 1,047,576 |
| GPT-4.1-nano        | `gpt-4.1-nano` | 1,047,576 |
| GPT-4o              | `gpt-4o`       | 128,000   |
| GPT-4o-mini         | `gpt-4o-mini`  | 128,000   |

## Upstream docs

- [OpenAI Vision documentation](https://platform.openai.com/docs/guides/vision)
- [OpenAI API keys](https://platform.openai.com/api-keys)
