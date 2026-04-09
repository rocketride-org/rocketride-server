---
title: MCP Client
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>MCP Client - RocketRide Documentation</title>
</head>

## What it does

Connects to an external [Model Context Protocol](https://modelcontextprotocol.io/) server and exposes its tools to agent nodes. Agents discover and invoke tools from the connected MCP server during their reasoning loop. This node has no pipeline lanes — it is connected to agents via the `tools` invoke channel.

Tools are namespaced as `serverName.toolName` (e.g. `mcp.search_docs`), where `serverName` is set in configuration.

## Configuration

| Field       | Description                                          |
| ----------- | ---------------------------------------------------- |
| Server name | Namespace prefix for all tools from this server      |
| Transport   | How to connect: `stdio`, `streamable-http`, or `sse` |

### STDIO transport

Launches a local subprocess as the MCP server.

| Field        | Description                                                        |
| ------------ | ------------------------------------------------------------------ |
| Command line | Command to launch the MCP server (e.g. `python -m rocketride_mcp`) |

### Streamable HTTP transport

| Field        | Description                                  |
| ------------ | -------------------------------------------- |
| Endpoint     | MCP server URL (e.g. `http://host:port/mcp`) |
| Headers      | Extra HTTP headers                           |
| Bearer token | Optional Authorization bearer token          |

### Legacy HTTP+SSE transport

| Field        | Description                                           |
| ------------ | ----------------------------------------------------- |
| SSE endpoint | Legacy MCP SSE URL (e.g. `http://127.0.0.1:8000/sse`) |
| Headers      | Extra HTTP headers                                    |
| Bearer token | Optional Authorization bearer token                   |

## Profiles

| Profile                                   | Transport         | Notes                               |
| ----------------------------------------- | ----------------- | ----------------------------------- |
| RocketRide MCP server (stdio) _(default)_ | `stdio`           | Launches `python -m rocketride_mcp` |
| Generic MCP server (Streamable HTTP)      | `streamable-http` | Enter endpoint URL                  |
| Generic MCP server (legacy HTTP+SSE)      | `sse`             | Enter SSE endpoint URL              |

## Upstream docs

- [Model Context Protocol specification](https://modelcontextprotocol.io/)
