---
title: Named Entity Recognition
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Named Entity Recognition - RocketRide Documentation</title>
</head>

## What it does

Extracts named entities (people, organizations, locations, dates, etc.) from text using HuggingFace transformer models. Entities are added to document metadata for downstream filtering, search, and analysis. Runs locally — GPU-capable.

**Lanes:**

| Lane in     | Lane out    | Description                                             |
| ----------- | ----------- | ------------------------------------------------------- |
| `text`      | `text`      | Extract entities, pass original text through            |
| `documents` | `documents` | Extract entities, enrich documents with entity metadata |

## Configuration

| Field                | Description                                                                            |
| -------------------- | -------------------------------------------------------------------------------------- |
| Model                | NER model to use (see profiles below)                                                  |
| Aggregation strategy | How to combine word pieces into entities (`simple`, `first`, `average`, `max`, `none`) |
| Minimum confidence   | Confidence threshold for entity filtering (0.0–1.0, default `0.9`)                     |
| Store in metadata    | Add extracted entities to document metadata (default on)                               |

## Profiles

| Profile                          | Model                                               | Notes                                |
| -------------------------------- | --------------------------------------------------- | ------------------------------------ |
| BERT Large (English) _(default)_ | `dbmdz/bert-large-cased-finetuned-conll03-english`  | High accuracy for English            |
| BERT Base (English)              | `dslim/bert-base-NER`                               | Balanced performance                 |
| DistilBERT (English)             | `Davlan/distilbert-base-multilingual-cased-ner-hrl` | Fast and lightweight                 |
| XLM-RoBERTa (Multilingual)       | `Davlan/xlm-roberta-base-ner-hrl`                   | 100+ languages                       |
| DeBERTa v3 (English)             | `dslim/distilbert-NER`                              | State-of-the-art accuracy            |
| BioBERT (Biomedical)             | `dmis-lab/biobert-base-cased-v1.1`                  | Medical/scientific entities          |
| Custom                           | _(user-specified)_                                  | Any compatible HuggingFace NER model |

## Upstream docs

- [HuggingFace token classification models](https://huggingface.co/models?pipeline_tag=token-classification)
