---
title: 'Transcribe - RocketRide Documentation'
date: 2026-04-08
sidebar_position: 1
---

## What it does

Transcribes audio or video to text using [OpenAI Whisper](https://github.com/openai/whisper). Buffers incoming audio in 60-second chunks, runs Whisper with built-in VAD, and emits complete sentences to the `text` lane.

**Lanes:** `audio` → `text`, `video` → `text`

Runs locally via `faster-whisper` — no API key required. Routes to a model server automatically if `--modelserver` is set.

## Configuration

| Field               | Default | Description                                                                              |
| ------------------- | ------- | ---------------------------------------------------------------------------------------- |
| Model               | `base`  | Whisper model size (see table below)                                                     |
| `silence_threshold` | `0.25`  | VAD probability threshold — speech below this confidence is treated as silence (0.0–1.0) |
| `min_seconds`       | `240`   | Minimum audio (seconds) buffered before looking for a split point                        |
| `max_seconds`       | `300`   | Maximum audio (seconds) to buffer before forcing transcription                           |

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
