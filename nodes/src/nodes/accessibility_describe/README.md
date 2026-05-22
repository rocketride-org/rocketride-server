---
title: Accessibility Describe
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Accessibility Describe - RocketRide Documentation</title>
</head>

## What it does

Analyzes an image using Google Gemini Vision and produces a structured scene description optimized for blind and visually impaired users. Output covers environment type, hazards with positions, key objects, visible text, people, and navigation guidance — kept under 150 words by default.

**Lanes:** `image` → `text`

## Models

| Model                        | Notes                                    |
| ---------------------------- | ---------------------------------------- |
| Gemini 2.5 Flash _(default)_ | Fast, efficient — good for real-time use |
| Gemini 2.5 Pro               | Highest quality                          |
| Gemini 2.0 Flash             | Balanced                                 |

All models use a 1M token context window. Requires a **Google AI API key** from [aistudio.google.com](https://aistudio.google.com/apikey).

## Configuration

| Field               | Default            | Description                                                                                       |
| ------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| Vision Model        | `gemini-2.5-flash` | Which Gemini model to use                                                                         |
| API Key             | —                  | Google AI API key                                                                                 |
| System Instructions | built-in           | Sets the assistant's overall behavior and priorities                                              |
| Analysis Prompt     | built-in           | Prompt sent with each image                                                                       |
| Hazard Priority     | `High`             | `High` always leads with hazards; `Medium` includes them when present; `Low` uses standard order  |
| Spatial Format      | `Clock`            | `Clock` uses clock positions (12 o'clock); `Relative` uses left/right/ahead; `Both` combines them |

## Default output structure

```
1. ENVIRONMENT  — type of place
2. HAZARDS      — obstacles, stairs, vehicles (with positions)
3. KEY OBJECTS  — notable items with clock positions and distances
4. TEXT         — any visible text read verbatim
5. PEOPLE       — count, positions, and actions
6. NAVIGATION   — clear path forward, turns, or barriers
```

Customize the **Analysis Prompt** field to change this structure.
