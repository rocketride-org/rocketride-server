---
title: Remote Processing
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Remote Processing - RocketRide Documentation</title>
</head>

## What it does

Forwards pipeline execution to a separate RocketRide server. The pipeline configuration is sent to the remote server over HTTP, data streams through a WebSocket connection, and results are returned when processing completes. Use this to run GPU-heavy or resource-intensive sub-pipelines on a dedicated machine.

**Lanes:**

| Lane in | Lane out    | Description                                             |
| ------- | ----------- | ------------------------------------------------------- |
| `Data`  | `documents` | Send data to the remote pipeline and receive its output |

## Configuration

| Field   | Description                                    |
| ------- | ---------------------------------------------- |
| Host    | Hostname or IP of the remote RocketRide server |
| Port    | Server port (required, no default)             |
| API Key | Authentication key for the remote server       |

## Profiles

| Profile           | Description                                                                |
| ----------------- | -------------------------------------------------------------------------- |
| Local _(default)_ | Routes to a pipeline on the same machine                                   |
| Remote server     | Routes to a pipeline on a separate host — requires host, port, and API key |

## Notes

- Self-hosted deployments only — not available on RocketRide Cloud.
- The remote server must be running a RocketRide instance with the server component enabled.
