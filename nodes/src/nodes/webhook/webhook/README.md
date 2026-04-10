---
title: Webhook
date: 2026-04-09
sidebar_position: 1
---

<head>
  <title>Webhook - RocketRide Documentation</title>
</head>

## What it does

Source node that exposes an HTTP POST endpoint. External tools, scripts, or services send files or data to the URL, triggering the pipeline to process the uploaded content.

After the pipeline starts, the Project Log displays the webhook URL and public authorization key.

**Lanes:**

| Lane in | Lane out                                  | Description                         |
| ------- | ----------------------------------------- | ----------------------------------- |
| —       | `data`, `text`, `audio`, `video`, `image` | Data received from the HTTP request |

## Configuration

None. The endpoint URL and authorization key are generated automatically when the pipeline starts.
