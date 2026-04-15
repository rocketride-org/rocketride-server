---
title: Gemini Vision
date: 2026-04-14
sidebar_position: 1
---

<head>
  <title>Gemini Vision - RocketRide Documentation</title>
</head>

## What it does

Sends images to Google Gemini vision-capable models and returns text analysis. Accepts either a single image or a stream of image documents (e.g. from the frame grabber). Metadata such as frame number and timestamp is preserved on the `documents` output.

All profiles support a 1M token context window, making Gemini Vision well-suited for high-volume frame analysis pipelines where many images are processed in sequence.

**Lanes:**

| Lane in     | Lane out    | Description                                                                    |
| ----------- | ----------- | ------------------------------------------------------------------------------ |
| `image`     | `text`      | Analyze a single image, receive text                                           |
| `documents` | `documents` | Analyze image documents, return text analysis with original metadata preserved |

## Configuration

| Field               | Description                                             |
| ------------------- | ------------------------------------------------------- |
| Model               | Gemini vision model to use (see profiles below)         |
| API Key             | Google AI API key (see below)                           |
| System Instructions | Define the model's role and behavior for image analysis |
| Analysis Prompt     | Describe what to analyze or extract from the image      |

## API Key

Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Keys are free for development use and grant access to all Gemini models listed below.

## Profiles

**Gemini 2.5**

| Profile                      | Model                          | Context   |
| ---------------------------- | ------------------------------ | --------- |
| Gemini 2.5 Flash _(default)_ | `models/gemini-2.5-flash`      | 1,048,576 |
| Gemini 2.5 Pro               | `models/gemini-2.5-pro`        | 1,048,576 |
| Gemini 2.5 Flash Lite        | `models/gemini-2.5-flash-lite` | 1,048,576 |

**Gemini 3.1 (Preview)**

| Profile                        | Model                                   | Context   |
| ------------------------------ | --------------------------------------- | --------- |
| Gemini 3.1 Pro Preview         | `models/gemini-3.1-pro-preview`         | 1,048,576 |
| Gemini 3.1 Flash Image Preview | `models/gemini-3.1-flash-image-preview` | 131,072   |

**Custom** — specify any Gemini model ID and token limit directly.

### Choosing a profile

- **Flash Lite** — fastest and cheapest; good for high-throughput frame pipelines where speed matters more than detail
- **Flash** — balanced speed and quality; the recommended default for most vision tasks
- **Pro** — highest quality analysis; use when accuracy is critical and latency is acceptable
- **3.1 Pro Preview / Flash Image Preview** — latest generation previews; expect higher capability but potential instability as models are still in preview

## Upstream docs

- [Gemini API documentation](https://ai.google.dev/gemini-api/docs)
- [Gemini model overview](https://ai.google.dev/gemini-api/docs/models)
- [Google AI Studio](https://aistudio.google.com/)
