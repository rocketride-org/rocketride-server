---
title: TwelveLabs
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>TwelveLabs - RocketRide Documentation</title>
</head>

## What it does

Analyzes video using the TwelveLabs Pegasus model and returns a text response. The video is uploaded to a temporary TwelveLabs index, analyzed with your configured instructions, and the index is deleted when done. Supports MP4, MOV, AVI, WebM, MKV, and MPG.

**Lanes:**

| Lane in | Lane out | Description                          |
| ------- | -------- | ------------------------------------ |
| `video` | `text`   | Analyze video and return text output |

## Configuration

| Field        | Description                                                 |
| ------------ | ----------------------------------------------------------- |
| API Key      | TwelveLabs API key                                          |
| Instructions | One or more prompts sent to the model to guide the analysis |

## Upstream docs

- [TwelveLabs documentation](https://docs.twelvelabs.io)
