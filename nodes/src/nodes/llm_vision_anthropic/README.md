---
title: Anthropic Vision
date: 2026-04-14
sidebar_position: 1
---

## What it does

Sends images to Anthropic Claude vision-capable models and returns text analysis. Accepts either a single image or a stream of image documents (e.g. from the frame grabber). Metadata such as frame number and timestamp is preserved on the `documents` output.

**Lanes:**

| Lane in     | Lane out    | Description                                                                    |
| ----------- | ----------- | ------------------------------------------------------------------------------ |
| `image`     | `text`      | Analyze a single image, receive text                                           |
| `documents` | `documents` | Analyze image documents, return text analysis with original metadata preserved |

## Configuration

| Field               | Description                                             |
| ------------------- | ------------------------------------------------------- |
| Model               | Vision model to use (see profiles below)                |
| API Key             | Anthropic API key (starts with `sk-ant-`)               |
| System Instructions | Define the model's role and behavior for image analysis |
| Analysis Prompt     | Describe what to analyze or extract from the image      |

## Profiles

| Profile                     | Model               | Context |
| --------------------------- | ------------------- | ------- |
| Claude Opus 4.6 _(default)_ | `claude-opus-4-6`   | 200,000 |
| Claude Sonnet 4.6           | `claude-sonnet-4-6` | 200,000 |
| Claude Haiku 4.5            | `claude-haiku-4-5`  | 200,000 |

## Image size limit

Anthropic enforces a **5 MB limit on the base64-encoded image string**. If a frame exceeds this, the node automatically re-encodes it as JPEG at progressively lower quality (85 → 70 → 55 → 40). A warning is logged when compression occurs:

```
Anthropic Vision: image is 5.4MB, exceeds 5MB limit — compressing to JPEG
Anthropic Vision: compressed to 0.5MB at JPEG quality=85
```

If the image cannot be brought under 5 MB at any quality level, the frame is skipped. This limit is specific to Anthropic — other vision nodes (Gemini, Ollama, Mistral) do not have this restriction.

## Upstream docs

- [Anthropic Claude vision documentation](https://platform.claude.com/docs/en/build-with-claude/vision.md)
- [Anthropic API keys](https://console.anthropic.com)
