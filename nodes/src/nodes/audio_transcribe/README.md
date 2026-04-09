---
title: Transcribe
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Transcribe - RocketRide Documentation</title>
</head>

## What it does

Transcribes audio or video to text using [OpenAI Whisper](https://github.com/openai/whisper). Buffers incoming audio in 60-second chunks, runs Whisper with built-in VAD, and emits complete sentences to the `text` lane.

**Lanes:** `audio` → `text`, `video` → `text`

Runs locally via `faster-whisper` — no API key required. Routes to a model server automatically if `--modelserver` is set.

## Configuration

| Field             | Default | Description                                             |
| ----------------- | ------- | ------------------------------------------------------- |
| Model             | `base`  | Whisper model size (see table below)                    |
| Silence Threshold | `0.25s` | Minimum silence duration to split speech segments       |
| Minimum Seconds   | `240s`  | Minimum audio buffered before looking for a split point |
| Maximum Seconds   | `300s`  | Maximum audio to buffer before forcing transcription    |
| VAD Level         | `1`     | Voice activity detection aggressiveness (0–3)           |

**VAD Level:**

| Level | Behavior                                                       |
| ----- | -------------------------------------------------------------- |
| `0`   | Most permissive — may include background noise                 |
| `1`   | Slightly aggressive — skips minor background noise _(default)_ |
| `2`   | Balanced — moderate filtering                                  |
| `3`   | Most aggressive — may cut off quiet or short speech            |

## Models

| Model    | Notes                          |
| -------- | ------------------------------ |
| Tiny     | Fastest, least accurate        |
| Base     | Fast, low accuracy _(default)_ |
| Small    | Medium speed and accuracy      |
| Medium   | Slower, high accuracy          |
| Large v3 | Slowest, highest accuracy      |

Models are downloaded from HuggingFace on first use. GPU is used automatically when available (`float16`).

## Language

Defaults to English (`en`). Change the `language` config value to transcribe other languages — any language supported by Whisper is accepted.
