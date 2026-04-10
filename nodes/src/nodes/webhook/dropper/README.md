---
title: Drag & Drop
date: 2026-04-09
sidebar_position: 1
---

<head>
  <title>Drag & Drop - RocketRide Documentation</title>
</head>

## What it does

Source node that serves a web-based drag-and-drop file upload interface. Users open the URL in a browser and drop files onto the page; each upload is sent through the pipeline for processing. Results are displayed in the browser across JSON, text, table, and image tabs.

After the pipeline starts, the Project Log displays the dropper URL and public authorization key.

**Lanes:**

| Lane in | Lane out | Description                |
| ------- | -------- | -------------------------- |
| —       | `data`   | Each uploaded file as data |

## Configuration

None. The dropper URL and authorization key are generated automatically when the pipeline starts.
