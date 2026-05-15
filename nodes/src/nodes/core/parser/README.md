---
title: Parser
date: 2026-04-11
sidebar_position: 1
---

<head>
  <title>Parser - RocketRide Documentation</title>
</head>

## What it does

Extracts structured content from a wide variety of document types. The Parser automatically identifies embedded content and routes it to the appropriate output lane, making text, tables, images, audio, and video accessible for downstream processing.

**Lanes:**

| Lane in | Lane out | Description             |
| ------- | -------- | ----------------------- |
| `data`  | `text`   | Extracted plain text    |
| `data`  | `table`  | Extracted tables        |
| `data`  | `image`  | Extracted images        |
| `data`  | `audio`  | Extracted audio streams |
| `data`  | `video`  | Extracted video streams |

## Configuration

None.
