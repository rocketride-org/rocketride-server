---
title: Supabase
date: 2026-06-01
sidebar_position: 1
---

<head>
  <title>Supabase - RocketRide Documentation</title>
</head>

## What it does

Connects to the official [Supabase MCP server](https://github.com/supabase-community/supabase-mcp) and exposes its tools to agent nodes. Agents discover and invoke Supabase tools (database queries, schema inspection, storage operations, and more) during their reasoning loop. This node has no pipeline lanes — it is connected to agents via the `tools` invoke channel.

Tools are namespaced as `supabase.<toolName>` (e.g. `supabase.list_tables`).

The node uses Streamable HTTP transport to connect to `https://mcp.supabase.com/mcp` (Supabase-hosted). A local Supabase CLI endpoint is also supported.

## Configuration

| Field          | Description                                                                               |
| -------------- | ----------------------------------------------------------------------------------------- |
| Server name    | Namespace prefix for all tools from this server (default: `supabase`)                    |
| Project ref    | Supabase project reference ID. Strongly recommended — scopes tools to one project.       |
| Access token   | Personal access token for CI/headless use. Set to `${SUPABASE_ACCESS_TOKEN}` to read from the environment. Leave blank for OAuth 2.1 browser-based auth. |
| Read-only      | Restrict to a read-only Postgres user. Recommended for agent pipelines that should not write. |
| Feature groups | Comma-separated tool groups to enable (e.g. `database,docs,storage`). Blank = all.      |
| Use local CLI  | Connect to `http://localhost:54321/mcp` instead of the remote server.                    |

## Authentication

| Method                             | When to use                                          |
| ---------------------------------- | ---------------------------------------------------- |
| OAuth 2.1 (browser-based)          | Interactive use; no token setup required             |
| `${SUPABASE_ACCESS_TOKEN}` bearer  | CI pipelines, headless environments, automated runs  |

Generate a personal access token at: https://supabase.com/dashboard/account/tokens

## Profiles

| Profile                            | Endpoint                           | Notes                                          |
| ---------------------------------- | ---------------------------------- | ---------------------------------------------- |
| Supabase (remote MCP server) _(default)_ | `https://mcp.supabase.com/mcp` | Supabase-hosted; requires access token or OAuth |
| Supabase CLI (local MCP server)   | `http://localhost:54321/mcp`       | Requires `supabase start` to be running        |

## URL parameters

The Supabase MCP server accepts query parameters on the endpoint URL. This node constructs them from the configuration fields:

| Parameter     | Config field    | Effect                                          |
| ------------- | --------------- | ----------------------------------------------- |
| `project_ref` | Project ref     | Scope tools to one project                      |
| `read_only`   | Read-only       | Restrict to read-only Postgres user             |
| `features`    | Feature groups  | Enable a subset of tool groups                  |

## MCP server version

The Supabase MCP server is pre-1.0 (v0.8.1 as of May 2026). Breaking changes between versions should be expected.

## Upstream docs

- [Supabase MCP docs](https://supabase.com/docs/guides/ai-tools/mcp)
- [Supabase MCP server repo](https://github.com/supabase-community/supabase-mcp)
- [Model Context Protocol specification](https://modelcontextprotocol.io/)
