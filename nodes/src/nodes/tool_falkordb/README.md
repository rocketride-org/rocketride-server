---
title: FalkorDB
date: 2026-06-11
sidebar_position: 1
---

## What it does

Lets agents query a [FalkorDB](https://www.falkordb.com) graph database with Cypher. Queries are **read-only by default** — they run via `GRAPH.RO_QUERY`, so the server itself rejects write clauses; flip *Allow Writes* to let the agent mutate the graph. Values always go through Cypher parameters (`$name`), which FalkorDB treats as data, never as query text.

## Tools

| Tool                  | Description                                              |
| --------------------- | -------------------------------------------------------- |
| `falkordb.query`      | Run a Cypher query and return rows                       |
| `falkordb.list_graphs`| List graph names on the server                           |
| `falkordb.get_schema` | Node labels, relationship types and property keys        |

### falkordb.query

| Parameter | Required | Description                                              |
| --------- | -------- | -------------------------------------------------------- |
| `cypher`  | yes      | Cypher query; reference values as `$name`                 |
| `params`  | no       | Values for the `$name` placeholders (injection-safe)      |
| `graph`   | no       | Graph to query (default from config)                      |

Returns `columns`, `rows` (nodes/edges serialized to objects, capped at *Max Rows* with a `truncated` flag) and, when writes are enabled, non-zero write `stats`.

### falkordb.list_graphs

No parameters. Returns `graphs`.

### falkordb.get_schema

| Parameter | Required | Description                          |
| --------- | -------- | ------------------------------------ |
| `graph`   | no       | Graph to inspect (default from config) |

Returns `labels`, `relationship_types` and `property_keys`.

## Configuration

| Field             | Description                                                            |
| ----------------- | ---------------------------------------------------------------------- |
| Host / Port       | FalkorDB endpoint (local Docker, self-hosted, or FalkorDB Cloud)        |
| Username / Password | Credentials; FalkorDB Cloud uses `default` + instance password        |
| TLS               | Enable for TLS endpoints                                                |
| Default Graph     | Graph used when the agent does not pass one                             |
| Allow Writes      | OFF = `GRAPH.RO_QUERY` (server rejects writes); ON = full read/write    |
| Max Rows          | Row cap per query returned to the agent                                 |
| Query Timeout (ms)| Server-side per-query timeout                                           |

## Local quickstart

```bash
docker run -p 6379:6379 -it --rm falkordb/falkordb:latest
```

Point the node at `localhost:6379` and ask the agent to `CREATE` (with *Allow Writes* on) or `MATCH` away.

## Upstream docs

- [FalkorDB documentation](https://docs.falkordb.com)
- [Cypher coverage](https://docs.falkordb.com/cypher/)
