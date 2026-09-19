---
title: Chat
date: 2026-04-09
sidebar_position: 1
---
<head>
  <title>Chat - RocketRide Documentation</title>
</head>

## What it does

Source node that serves a web-based chat interface. Users open the chat URL in a browser, type questions, and each submission flows through the pipeline as a questions lane. Results are returned in the chat window.

After the pipeline starts, the Project Log displays the chat URL and public authorization key.

**Lanes:**

| Lane in | Lane out    | Description                                               |
| ------- | ----------- | --------------------------------------------------------- |
| -       | questions   | Each message submitted via the chat UI becomes a question |

## Configuration

None. The chat URL and authorization key are generated automatically when the pipeline starts.

## Usage

1. Add a Chat source node to your pipeline.
2. Connect its questions output to a downstream node (e.g. an LLM or embedding node).
3. Press the play button on the Chat node to start it.
4. Click Chat now to open the chat interface, or use the URL shown in the Project Log.

## Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| Request URL is missing an http or https protocol | The Chat node started before the pipeline server was fully ready, or the node has no downstream connection. | Ensure at least one node is connected to the Chat questions output, then restart the pipeline. |
| Chat opens but responses are empty | The downstream LLM node is missing an API key or is misconfigured. | Open the LLM node settings and verify the API key and model selection. |
| Chat window does not open | Browser popup blocker prevented the window. | Copy the chat URL from the Project Log and open it manually. |

## Combining with other sources

A pipeline can have both a Chat and a Webhook source. Use Webhook for document ingestion and Chat for interactive Q&A. Both feed into the same downstream nodes and the pipeline routes data by lane type automatically.
