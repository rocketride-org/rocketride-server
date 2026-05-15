---
title: Image Cleanup
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Image Cleanup - RocketRide Documentation</title>
</head>

## What it does

Pre-processes images for OCR. Converts to grayscale, applies Otsu thresholding, deskews, and runs morphological cleanup to remove small noise in character shapes. Place this node before an OCR node when working with scanned or low-quality images.

**Lanes:**

| Lane in | Lane out | Description                          |
| ------- | -------- | ------------------------------------ |
| `image` | `image`  | Clean and output the processed image |

## Configuration

No configuration fields. The cleanup pipeline runs automatically.
