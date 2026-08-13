---
title: Fingerprinter
date: 2026-04-11
sidebar_position: 1
---

<head>
  <title>Fingerprinter - RocketRide Documentation</title>
</head>

## What it does

Generates a deterministic fingerprint (hash) of each document's content as it passes through the pipeline. The hash is computed from the raw or normalized text, so identical content always produces the same fingerprint regardless of metadata. Use it for deduplication, content tracking, and identity verification before indexing.

**Lanes:** `data` → `data`

## Configuration

None.
