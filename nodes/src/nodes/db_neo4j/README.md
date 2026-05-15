---
title: Neo4j
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Neo4j - RocketRide Documentation</title>
</head>

## What it does

Neo4j node with two roles: pipeline node (natural-language questions → Cypher → results via lanes) and tool node (agents call it directly). Read-only — write operations are blocked by design.

## Connections

| Connection | Required | Description                                       |
| ---------- | -------- | ------------------------------------------------- |
| `llm`      | yes      | LLM used to generate Cypher from natural language |

## As a pipeline node

**Lanes:**

| Lane in     | Lane out  | Description                                              |
| ----------- | --------- | -------------------------------------------------------- |
| `questions` | `table`   | Translate question → Cypher → execute, return as table   |
| `questions` | `text`    | Translate question → Cypher → execute, return as text    |
| `questions` | `answers` | Translate question → Cypher → execute, return as answers |

Graph schema (node labels, properties, relationship types) is reflected at startup and included in every LLM prompt.

## As a tool

When connected to an agent, exposes three functions under the configured server name (default: `neo4j`):

| Function           | Description                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `neo4j.get_data`   | Natural language → Cypher → execute, returns rows (default 250, max 25 000)                |
| `neo4j.get_schema` | Returns node labels, property types, and relationship types; accepts optional label filter |
| `neo4j.get_cypher` | Natural language → Cypher only — no execution                                              |

## Configuration

| Field                   | Default                  | Description                                                                      |
| ----------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| Connection URI          | `neo4j://localhost:7687` | Bolt URI. Use `neo4j+s://` for TLS (e.g. Neo4j Aura)                             |
| Authentication          | `Username & Password`    | `Username & Password` or `Bearer Token`                                          |
| User                    | `neo4j`                  | Username (userpass auth only)                                                    |
| Password                | —                        | Password (userpass auth only)                                                    |
| Bearer Token            | —                        | Token (bearer auth only)                                                         |
| Database Name           | `neo4j`                  | Target database                                                                  |
| Graph Description       | —                        | Plain-language description of the graph — helps the LLM generate accurate Cypher |
| Max Validation Attempts | `5`                      | Retry limit for EXPLAIN-based Cypher validation (range 1–20)                     |

## Cypher validation

Generated Cypher is validated with `EXPLAIN` before execution. If validation fails, the error is fed back to the LLM for a corrected query. This repeats up to **Max Validation Attempts** times. Only `MATCH`, `OPTIONAL MATCH`, `WITH`, `WHERE`, `RETURN`, `ORDER BY`, `SKIP`, and `LIMIT` are permitted.

## Upstream docs

- [Neo4j documentation](https://neo4j.com/docs/)
- [Neo4j Aura](https://neo4j.com/cloud/aura/)
