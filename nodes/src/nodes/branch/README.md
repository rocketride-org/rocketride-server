---
title: Conditional Branch
date: 2026-05-16
sidebar_position: 1
---

<head>
  <title>Conditional Branch - RocketRide Documentation</title>
</head>

## What it does

Routes questions or answers to one of two output lanes by evaluating ordered rules. The first matching rule wins. If no rule matches, the configured default lane is used.

**Lanes:**

| Lane in     | Lane out    | Description                                                        |
| ----------- | ----------- | ------------------------------------------------------------------ |
| `questions` | `questions` | Pass matching questions through unchanged                          |
| `questions` | `answers`   | Convert the rendered question prompt into an answer                 |
| `answers`   | `answers`   | Pass matching answers through unchanged                            |
| `answers`   | `questions` | Convert the answer text into a question with context and history    |

## Conditions

| Type              | Description                                      |
| ----------------- | ------------------------------------------------ |
| Keyword Match     | Match any or all comma-separated keywords        |
| Regex Pattern     | Match text with a regular expression             |
| Text Length       | Match inclusive minimum and maximum text lengths |
| Score Threshold   | Compare a numeric score with `>=`, `<=`, `==`, `>`, or `<` |
| Field Equals      | Compare a metadata field to an expected value    |
| Sentiment         | Match `positive`, `negative`, or `neutral` text  |
| Always True/False | Constant rules for explicit fallbacks            |

Invalid regex patterns and unsupported condition values do not crash the node; they evaluate as non-matches.

## Configuration

| Field        | Description                                                               |
| ------------ | ------------------------------------------------------------------------- |
| Profile      | Preset condition editor: keyword, regex, length, score, or sentiment      |
| Default Lane | Output lane used when no rule matches                                     |
| Rules        | Ordered rule list with a condition and target lane                        |

Target lanes must be `questions` or `answers`. Invalid lanes raise an error instead of silently routing data to the wrong output.

## Cross-lane conversion

Questions routed to `answers` become an answer containing only the rendered prompt text. Question history, documents, and context are not preserved because the answer schema has no equivalent fields.

Answers routed to `questions` become a question containing the answer text. The same text is also added to question context and to conversation history as an assistant turn.
