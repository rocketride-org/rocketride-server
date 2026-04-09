---
title: Local Text Output
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Local Text Output - RocketRide Documentation</title>
</head>

## What it does

Writes pipeline text output to the local filesystem. Receives text from upstream nodes and saves each object as a `.txt` file, preserving the source directory structure inside the configured output path. This is a sink node — it has no output lane.

Only available in self-hosted deployments (not SaaS).

**Lanes:**

| Lane in | Description                   |
| ------- | ----------------------------- |
| `text`  | Text content to write to disk |

## Configuration

| Field      | Description                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| Store Path | Output directory to write files into                                                                                       |
| Exclude    | Path prefix to strip from source paths before writing (e.g. `Users/Downloads/`). Set to `N/A` to use the full source path. |

The source file extension is replaced with `.txt` on output. Subdirectories are created automatically.
