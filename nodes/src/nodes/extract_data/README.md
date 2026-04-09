---
title: Data Extractor
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Data Extractor - RocketRide Documentation</title>
</head>

## What it does

Reads text or tables and uses an LLM to extract a structured set of fields you define. Results are accumulated across all chunks of a document and emitted as consolidated table data (rows emitted as individual documents) at the end.

**Lanes:**

| Lane in | Lane out    | Description                                                      |
| ------- | ----------- | ---------------------------------------------------------------- |
| `text`  | `answers`   | Extract fields from text, emit as JSON                           |
| `text`  | `documents` | Extract fields from text, emit one document per row              |
| `table` | `answers`   | Extract/transform fields from a table, emit as JSON              |
| `table` | `documents` | Extract/transform fields from a table, emit one document per row |

## Connections

| Connection | Required | Description                      |
| ---------- | -------- | -------------------------------- |
| `llm`      | yes      | LLM used to extract field values |

## Configuration

Define up to 32 fields. For each field:

| Field         | Description                                   |
| ------------- | --------------------------------------------- |
| Column        | Output field name                             |
| Type          | Expected data type (see below)                |
| Default Value | Fallback if the field is not found (optional) |

**Supported types:** Text, Number, Integer, Date, Time, DateTime, Timestamp, Binary, JSON, HTML, URL, Email, Phone, IPv4, IPv6, UUID, GUID

## Behaviour

The LLM infers field values even when the source text doesn't use the exact column names — it reasons about what each column likely contains. Multiple chunks are merged progressively, filling in any gaps from earlier chunks, before the final result is emitted.
