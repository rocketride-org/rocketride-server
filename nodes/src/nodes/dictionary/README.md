---
title: Dictionary
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Dictionary - RocketRide Documentation</title>
</head>

## What it does

Reads text and uses an LLM to extract a glossary of domain-specific terms, acronyms, and company-specific vocabulary. Each extracted term is emitted as a separate document containing a `{"term": "...", "description": "..."}` JSON object.

**Lanes:**

| Lane in | Lane out    | Description                                                |
| ------- | ----------- | ---------------------------------------------------------- |
| `text`  | `documents` | Extract term/description pairs, emit one document per term |

## Connections

| Connection | Required | Description                          |
| ---------- | -------- | ------------------------------------ |
| `llm`      | yes      | LLM used to extract and define terms |

## Configuration

No configuration fields. Connect an LLM and wire text in.

## Usage

Place this node after a text source (e.g. parse, preprocessor) and before a vector store. The output documents can be ingested into a store and queried later to enrich LLM context with domain-specific definitions.
