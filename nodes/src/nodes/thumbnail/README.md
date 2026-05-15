---
title: Thumbnail
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Thumbnail - RocketRide Documentation</title>
</head>

## What it does

Generates a 128×128 PNG thumbnail from an input image. Accepts raw images or image documents and outputs the resized result downstream. Useful for creating lightweight image previews before passing them to a vision LLM, reducing token usage and processing time compared to full-resolution images.

**Lanes:**

| Lane in     | Lane out    | Description                           |
| ----------- | ----------- | ------------------------------------- |
| `image`     | `image`     | Resize raw image to thumbnail         |
| `image`     | `documents` | Resize raw image and emit as document |
| `documents` | `documents` | Resize image documents to thumbnail   |

## Configuration

None.
