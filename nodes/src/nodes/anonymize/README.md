---
title: Anonymize
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Anonymize - RocketRide Documentation</title>
</head>

## What it does

Scans text for sensitive entities (names, emails, phone numbers, organizations, etc.) using a local GLiNER NER model and replaces each detected character with a masking character. Text structure is preserved — only the entity spans are replaced.

**Lanes:** `text` → `text`

**Example:**

```text
Input:  John Smith is a patient at St. Mary's Hospital.
Output: ████ █████ is a patient at ██ █████████████████.
```

## Configuration

| Field     | Default        | Description                                       |
| --------- | -------------- | ------------------------------------------------- |
| Model     | `GLiNER Small` | Which NER model to use (see table below)          |
| Character | `█`            | Character used to replace each detected character |

## Models

Models run locally — no API key required. Downloaded from HuggingFace on first use. GPU is supported.

| Profile                                        | Best for                                                      |
| ---------------------------------------------- | ------------------------------------------------------------- |
| GLiNER Small / Medium / Large                  | General English PII — use Small for speed, Large for accuracy |
| GLiNER PII Large                               | High-accuracy English PII                                     |
| GLiNER Merged Large                            | Combined from multiple datasets — broad coverage              |
| GLiNER Multi / Multi PII                       | Multilingual text                                             |
| Gretel Small / Large                           | Business-oriented NER                                         |
| GLiNER Korean / Italian / Arabic               | Language-specific                                             |
| GLiNER Community Small / Medium / Large (v2.5) | Community-trained general models                              |
| GLiNER Biomed Small / Large                    | Biomedical and clinical text                                  |
| Custom                                         | Enter any HuggingFace GLiNER model name                       |

> AI-based detection — 100% accuracy is not guaranteed. Review results before use in production.
