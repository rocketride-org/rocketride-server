---
title: Prompt
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Prompt - RocketRide Documentation</title>
</head>

## What it does

Assembles a structured `Question` object from multiple pipeline inputs and emits it downstream. This is the primary mechanism for injecting retrieved documents, extracted text, and table content into a question before it reaches an LLM or agent node.

Each input lane maps to a different section of the rendered prompt. The `questions` lane collects inputs as they arrive; the fully assembled question is not emitted until `closing()` is called, at which point all accumulated inputs are merged and the enriched question is emitted downstream.

**Lanes:**

| Lane in     | Lane out    | Description                                                                    |
| ----------- | ----------- | ------------------------------------------------------------------------------ |
| `documents` | —           | Added to `### Documents:` section of the prompt                                |
| `text`      | —           | Added to `### Context:` section of the prompt                                  |
| `table`     | —           | Added to `### Context:` section of the prompt                                  |
| `questions` | `questions` | Collects inputs; emits the fully assembled Question when `closing()` is called |

## Configuration

| Field        | Description                                                                       |
| ------------ | --------------------------------------------------------------------------------- |
| Instructions | One or more instruction strings added to `### System Instructions:` in the prompt |

## Rendered prompt structure

When the Question is consumed by an LLM or agent, it is rendered in this order:

```
### System Instructions:
    1) **User Instruction**: [your configured instructions]

### Context:
    1) [text or table content from text/table lanes]

### Documents:
    Document 1) Content: [document content from documents lane]

### Current Task:
    [question text from questions lane]
```

## Typical use

The most common use is passing retrieved documents or extracted text alongside a question into an agent or LLM — giving it context it wouldn't otherwise have.

**RAG into an LLM:**

```
           ┌──→ vector store ──→ documents ─┐
source ────┤                                ├──→ Prompt ──→ LLM
           └──────────────── questions ─────┘
```

**Passing context to an agent:**

```
text extractor ──→ text ──────────────────┐
vector store ───→ documents ──────────────┤
                                          ├──→ Prompt ──→ agent
source ─────────→ questions ──────────────┘
```
