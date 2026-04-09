---
title: OCR
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>OCR - RocketRide Documentation</title>
</head>

## What it does

Extracts text and tables from images using optical character recognition. Accepts raw images or image documents. The `image` lane produces both text and table output; the `documents` lane produces text only. Runs locally — GPU-capable.

**Lanes:**

| Lane in     | Lane out | Description                       |
| ----------- | -------- | --------------------------------- |
| `documents` | `text`   | Extract text from image documents |
| `image`     | `text`   | Extract text from a raw image     |
| `image`     | `table`  | Extract tables from a raw image   |

## Configuration

| Field            | Description                                                            |
| ---------------- | ---------------------------------------------------------------------- |
| OCR Profile      | Preconfigured language/engine combination (see profiles below)         |
| OCR Engine       | Engine for text extraction (overrides profile)                         |
| Script Family    | Language script for EasyOCR (does not apply to DocTR, Surya, or TrOCR) |
| Table OCR Engine | Engine used for table extraction (`doctr`, `easyocr`, or `surya`)      |

## Profiles

| Profile                     | Engine  | Notes                                          |
| --------------------------- | ------- | ---------------------------------------------- |
| Latin (English) _(default)_ | EasyOCR | English text                                   |
| Latin Extended (European)   | EasyOCR | Western European languages                     |
| Cyrillic (Russian, etc.)    | EasyOCR | Russian, Ukrainian, Bulgarian, etc.            |
| Arabic/Persian/Urdu         | EasyOCR | Right-to-left Arabic scripts                   |
| Devanagari (Hindi, etc.)    | EasyOCR | Hindi, Marathi, Nepali                         |
| Chinese (Simplified)        | EasyOCR | Simplified Chinese                             |
| Chinese (Traditional)       | EasyOCR | Traditional Chinese                            |
| Japanese                    | EasyOCR | Japanese                                       |
| Korean                      | EasyOCR | Korean                                         |
| DocTR (Language-agnostic)   | DocTR   | Document-focused, no language selection needed |
| Surya (Multi-language)      | Surya   | Broad language support                         |
| TrOCR (Transformer)         | TrOCR   | Transformer-based, English                     |

## Upstream docs

- [EasyOCR](https://github.com/JaidedAI/EasyOCR)
- [DocTR documentation](https://mindee.github.io/doctr/)
- [Surya](https://github.com/VikParuchuri/surya)
