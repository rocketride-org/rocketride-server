---
title: Mistral Vision
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Mistral Vision - RocketRide Documentation</title>
</head>

## What it does

Sends images to Mistral vision-capable models and returns text analysis. Accepts either a single image or a stream of image documents (e.g. from the frame grabber). Metadata such as frame number and timestamp is preserved on the `documents` output.

**Lanes:**

| Lane in     | Lane out    | Description                                                                    |
| ----------- | ----------- | ------------------------------------------------------------------------------ |
| `image`     | `text`      | Analyze a single image, receive text                                           |
| `documents` | `documents` | Analyze image documents, return text analysis with original metadata preserved |

## Configuration

| Field               | Description                                             |
| ------------------- | ------------------------------------------------------- |
| Model               | Vision model to use (see profiles below)                |
| API Key             | Mistral AI API key                                      |
| System Instructions | Define the model's role and behavior for image analysis |
| Analysis Prompt     | Describe what to analyze or extract from the image      |

## Profiles

| Profile                     | Model                 | Context |
| --------------------------- | --------------------- | ------- |
| Mistral Large 3 _(default)_ | `mistral-large-2512`  | 256,000 |
| Mistral Medium 3.1          | `mistral-medium-2508` | 128,000 |
| Mistral Small 3.2           | `mistral-small-2506`  | 128,000 |
| Ministral 3 14B             | `ministral-14b-2512`  | 256,000 |
| Ministral 3 8B              | `ministral-8b-2512`   | 256,000 |
| Ministral 3 3B              | `ministral-3b-2512`   | 256,000 |

## Upstream docs

- [Mistral vision documentation](https://docs.mistral.ai/capabilities/vision/)
