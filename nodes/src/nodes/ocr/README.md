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

## OpenCV compatibility

All four engines share the `cv2` namespace but disagree on which OpenCV PyPI package and version they want. The project installs a single unified build — `opencv-contrib-python==4.13.0.92` — via `ai.common.opencv`, which also uninstalls competing variants (`opencv-python`, `opencv-python-headless`, `opencv-contrib-python-headless`) so only one `cv2` is active at runtime.

Upstream pins (as of the versions currently used):

| Engine  | PyPI package                               | Upstream OpenCV requirement           | Matches project's 4.13.0.92? |
| ------- | ------------------------------------------ | ------------------------------------- | ---------------------------- |
| EasyOCR | `easyocr` 1.7.2                            | `opencv-python-headless` (unpinned)   | Yes                          |
| DocTR   | `python-doctr` 1.0.1                       | `opencv-python <5.0.0, >=4.5.0`       | Yes                          |
| Surya   | `surya-ocr` 0.17.1                         | `opencv-python-headless==4.11.0.86`   | No — hard pin to 4.11.0.86   |
| TrOCR   | `craft-text-detector` 0.4.3 (detector dep) | `opencv-python <4.5.4.62, >=3.4.8.29` | No — caps below 4.5.4.62     |

Surya and TrOCR's detector pin OpenCV to versions the project deliberately overrides. They work because `ai.common.opencv` runs `depends()` at import time and force-aligns all four OpenCV variants to 4.13.0.92 _after_ the engines are installed. Always `from ai.common.opencv import cv2` before importing an OCR engine, or the wrong `cv2` may be resolved.

## Upstream docs

- [EasyOCR](https://github.com/JaidedAI/EasyOCR)
- [DocTR documentation](https://mindee.github.io/doctr/)
- [Surya](https://github.com/VikParuchuri/surya)
