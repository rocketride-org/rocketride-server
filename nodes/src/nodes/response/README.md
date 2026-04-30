---
title: HTTP Results
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>HTTP Results - RocketRide Documentation</title>
</head>

## What it does

Captures pipeline output and returns it as a structured JSON response. Each lane type is mapped to a named key in the response body. Used as the terminal node in pipelines triggered via HTTP.

**Lanes:**

| Lane in     | Lane out | Description                       |
| ----------- | -------- | --------------------------------- |
| `text`      | —        | Captured under the configured key |
| `table`     | —        | Captured under the configured key |
| `documents` | —        | Captured under the configured key |
| `questions` | —        | Captured under the configured key |
| `answers`   | —        | Captured under the configured key |
| `audio`     | —        | Captured under the configured key |
| `video`     | —        | Captured under the configured key |
| `image`     | —        | Captured under the configured key |

## Configuration

| Field      | Description                                                 |
| ---------- | ----------------------------------------------------------- |
| Lane       | Lane type to capture (`answers`, `documents`, `text`, etc.) |
| Result Key | Key name for this lane's data in the response body          |

Multiple lane-to-key mappings can be added to return several outputs in a single response.

## Response format

```json
{
  "name": "file.pdf",
  "path": "/some/directory",
  "metadata": { ... },
  "your_key": [ ...data... ],
  "result_types": { "your_key": "answers" }
}
```

`result_types` maps each configured key back to its original lane type.
