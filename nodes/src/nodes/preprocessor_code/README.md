---
title: Code Preprocessor
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Code Preprocessor - RocketRide Documentation</title>
</head>

## What it does

Splits source code text into chunks that respect syntax boundaries (functions, classes, blocks) rather than cutting mid-construct. Outputs documents ready for embedding or LLM processing.

**Lanes:**

| Lane in | Lane out    | Description                                         |
| ------- | ----------- | --------------------------------------------------- |
| `text`  | `documents` | Split source code into syntax-aware document chunks |

## Configuration

| Field                 | Description                                           |
| --------------------- | ----------------------------------------------------- |
| Language              | Programming language for parsing (see profiles below) |
| Maximum string length | Maximum characters per chunk (default `512`)          |

## Profiles

| Profile                 | Language                            |
| ----------------------- | ----------------------------------- |
| Auto detect _(default)_ | Infers language from file extension |
| Python                  | Python                              |
| JavaScript              | JavaScript                          |
| TypeScript              | TypeScript                          |
| C/C++                   | C and C++                           |
