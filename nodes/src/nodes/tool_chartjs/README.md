---
title: Chart (Chart.js)
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Chart (Chart.js) - RocketRide Documentation</title>
</head>

## What it does

Tool node that exposes a `generate_chart` function to agents. The agent passes raw data and the node uses the pipeline LLM to produce a valid [Chart.js v4](https://www.chartjs.org/) configuration, returned as a ` ```chartjs ` fenced block that the chat UI renders as an interactive chart.

**Tool name:** `chartjs.generate_chart`

## Connections

| Channel | Required | Description                                     |
| ------- | -------- | ----------------------------------------------- |
| `llm`   | yes      | LLM used to generate the Chart.js configuration |

## Tool input

| Field         | Required | Description                                                                                              |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `data`        | yes      | Raw data to chart — array of objects or key-value pairs                                                  |
| `chart_type`  | no       | `bar`, `line`, `pie`, `doughnut`, `radar`, `polarArea`, `scatter`, `bubble` — omit to let the LLM choose |
| `title`       | no       | Chart title                                                                                              |
| `description` | no       | Natural language description of the desired chart                                                        |

Data is truncated to 200 items / 20KB before being sent to the LLM.

## Output

A ` ```chartjs ` fenced block containing the Chart.js JSON configuration. The agent should place this verbatim in the answer — the UI renders it as a chart.

## Notes

- Output is pure static JSON — no JavaScript callbacks. Values that would normally require callbacks (e.g. formatted tooltip labels) are embedded directly in label strings.
- Connect this node to an agent via the `tool` invoke channel.
