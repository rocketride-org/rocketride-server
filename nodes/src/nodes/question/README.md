---
title: Question
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Question - RocketRide Documentation</title>
</head>

## What it does

Wraps incoming text as a `Question` object so it can flow into nodes that expect a `questions` lane — vector stores, LLMs, agents, and the Prompt node. No configuration required.

**Lanes:**

| Lane in | Lane out    | Description                                    |
| ------- | ----------- | ---------------------------------------------- |
| `text`  | `questions` | Wrap text as a Question and pass it downstream |

## Configuration

None.
