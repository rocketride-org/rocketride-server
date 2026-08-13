# rocketride_graph

A RocketRide-managed graph database node backed by PostgreSQL + Apache AGE in your own provisioned RocketRide cloud database — with **zero database setup**.

## What it does

Mirrors the `graph_neo4j` node: as a pipeline node it takes natural-language questions on the `questions` lane, asks a connected LLM to translate them to Cypher, executes, and emits results; as a tool node agents call `get_data`, `get_schema`, `get_query`, `execute`, and `dialect` (dialect: `age`).

Two differences from the generic graph nodes:

1. **No connection fields.** The per-tenant DSN is resolved from the account layer (`Account.resolve_db_dsn(client_id)`), keyed by the authenticated connection identity — the same seam as `rocketride_sql` and `rocketride_vector` (one database per tenant backs all three). Requires signing into RocketRide cloud; the open-source build without a cloud identity fails with `RocketRide cloud DB nodes require signing into RocketRide cloud`.
2. **Cypher → AGE translation.** Apache AGE cannot run bare Cypher, so every query path routes through the translation layer at `ai.common.graph.age` (openCypher ANTLR parse → firewall → dialect capability gate → `cypher()` envelope with synthesized column list → prepared-statement parameter binding → agtype decode). Even the raw EXECUTE path translates — only the *semantic* firewall is skipped there, never the resource caps.

## Safety model

- **Safe path** (LLM/tool reads): runs in a server-side **READ ONLY transaction** (writes are refused by Postgres itself), plus the layer's semantic firewall (no write clauses, no CALL) and the base's `is_cypher_safe` regex as defence-in-depth.
- **Resource caps** (both paths): query length limit, variable-length traversal depth cap (unbounded `*` patterns are rejected), and a per-transaction `statement_timeout`.
- **EXECUTE** is gated by `allow_execute` (default off); isolation for raw writes is the database-per-tenant boundary.
- All per-query settings are `SET LOCAL` — the cloud endpoint is a transaction-mode pooler, so session-level `SET` would bleed across tenants. AGE is preloaded server-side (no `LOAD`).

## Graph provisioning (open)

Ownership of per-tenant `create_graph` is **pending** (cloud provisioner vs node). Until decided, the node fails fast at pipeline start when the configured graph does not exist rather than creating one silently.

## Configuration

### Fields

| Field | Type | Description |
|---|---|---|
| `graph` | string | Default "rocketride". Name of the AGE graph to query |
| `db_description` | string | Default empty. What the graph contains; improves LLM query quality |
| `max_attempts` | integer | Default 5. LLM re-ask ceiling when validation rejects generated Cypher |
| `max_rows` | integer | Default 1000. Row ceiling for the read path |
| `query_timeout_ms` | integer | Default 30000. Per-transaction statement timeout |
| `allow_execute` | boolean | Default false. Enables the raw EXECUTE path |

There are intentionally no `host` / `user` / `password` / `database` fields.

### Dialect notes (AGE 1.5.0)

The capability table (see `ai.common.graph.age.capabilities`) rejects constructs the cloud's AGE 1.5.0 cannot run with actionable messages: `datetime()` (store ISO-8601 strings or epoch numbers), `RETURN *` (list columns explicitly), `ORDER BY` on a projection alias (order by the expression), `MERGE ... ON CREATE/MATCH SET` (plain `MERGE` then a separate `SET`), label predicates in `WHERE` (put the label in the `MATCH` pattern), multi-labels like `(n:A:B)` (model the second label as a property or category-node edge), and `shortestPath()` (use a bounded variable-length match). All cells are empirically verified against the exact cloud pin — none pass through unverified.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
