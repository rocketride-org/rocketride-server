---
title: Chat
date: 2026-04-09
sidebar_position: 1
---

<head>
  <title>Chat - RocketRide Documentation</title>
</head>

## What it does

Source node that serves a web-based chat interface. Users open the chat URL in a browser, type questions, and each submission flows through the pipeline as a `questions` lane. Results are returned in the chat window.

After the pipeline starts, the Project Log displays the chat URL and public authorization key.

**Lanes:**

| Lane in | Lane out    | Description                                               |
| ------- | ----------- | --------------------------------------------------------- |
| —       | `questions` | Each message submitted via the chat UI becomes a question |

## Configuration

None. The chat URL and authorization key are generated automatically when the pipeline starts.
