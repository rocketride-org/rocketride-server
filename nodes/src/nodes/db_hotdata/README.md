# Hotdata

A database and tool node backed by one **ephemeral** [Hotdata](https://www.hotdata.dev/) database per pipeline run — load data, index it, query it, and it is gone when the run ends.

## What it does

Every other database node in the catalogue points at a store that outlives the run. This one does the opposite: the first time it is used it provisions a Hotdata database with a TTL, and `endGlobal` deletes it. That makes it the right choice for scratch work — pull a dataset in, join and aggregate it, emit the answer, leave nothing behind.

As a pipeline node it takes natural-language questions on the `questions` lane and emits results on `table` / `text` / `answers`, and it loads structured rows arriving on the `answers` lane. As a tool node an agent drives it directly.

It needs a connected LLM (the `llm` control connection) to translate questions into SQL, in the same way `db_postgres` and `rocketride_sql` do.

## Tools

| Tool | What it does |
| --- | --- |
| `load_data` | Load rows, or a previous query result by `result_id`, into a table. Creates the table if needed |
| `get_data` | Answer a plain-language question. The bound LLM writes the SQL; failures are retried with the error fed back |
| `get_sql` | Generate the SQL for a question without running it |
| `execute` | Run one raw read-only SQL statement. Gated by `allow_execute` |
| `get_schema` | Live tables and columns from `information_schema` |
| `build_index` | Build a `bm25`, `vector` or `sorted` index on a column |
| `dialect` | The full SQL dialect briefing — read this before writing SQL by hand |

## Lanes

| Lane | Direction | Behaviour |
| --- | --- | --- |
| `questions` | in | Natural-language question, answered and emitted to `table` / `text` / `answers` |
| `answers` | in | Structured rows, loaded into the configured table |
| `table` | out | Query results as a Markdown table |
| `text` | out | Query results rendered as text |
| `answers` | out | Query results as an answer payload |

## Setup

Set an API key and workspace ID on the node, or export `HOTDATA_API_KEY` and `HOTDATA_WORKSPACE`. The default endpoint is `https://api.hotdata.dev`.

Wire an LLM to the node's `llm` control connection — without one, natural-language querying cannot work. See `examples/db_hotdata.pipe`.

## SQL dialect

Hotdata runs **Apache DataFusion 54 behind the PostgreSQL parser dialect**. Treat that as "Postgres syntax, DataFusion semantics and function library" — not as Postgres. Call the `dialect` tool for the full briefing; the essentials:

- Postgres syntax works: `::` casts, CTEs, window functions, `DISTINCT ON`, `ILIKE`, `INTERVAL`.
- Unquoted identifiers fold to lowercase — double-quote any name with uppercase or spaces.
- The function library is DataFusion's. **No JSON/JSONB operators** (`->`, `->>`, `jsonb_*`), no `pg_catalog`, no `to_number` or `age()`. Use `arrow_typeof`, `arrow_cast`, `date_bin`, `approx_percentile_cont` instead.
- Types are Arrow types (`Utf8`, `Int64`, `Timestamp`, `Decimal128`) — there is no native JSON, UUID or ENUM.
- Names are three-part `catalog.schema.table`; this database's own catalog is `default`.
- Search uses engine functions: `bm25_search(table, column, query)`, `vector_search(table, column, query)`, and `vector_distance(column, query)` for `ORDER BY`. Build the matching index first with `build_index`.

## Limits

- **The SQL surface is read-only.** `INSERT`, `UPDATE`, `DELETE` and all DDL are rejected by the server. `load_data` is the only way to get data in, and it uploads rather than issuing SQL.
- `allow_execute` is an application-level gate on raw SQL. It is **not** write protection — the SQL surface rejects writes regardless. It exists to keep untrusted callers from running expensive scans, which are billed per TB scanned.
- **`load_data` is a write path, and the SQL read-only guarantee does not cover it.** `replace`, `update` and `delete` modes overwrite or remove existing rows, so they are disabled unless `allow_destructive_load` is on. Without that gate an agent asked to "delete the bad rows" will route around the SQL guard by calling `load_data` with `mode=replace`. Default is append/upsert only.
- One statement per call; `SHOW TABLES` and `SHOW COLUMNS` error, so use `information_schema` or `DESCRIBE`.
- **Data is destroyed when the run ends.** The configured TTL is only a fallback for a crashed engine.
- Rate limits are dynamic and unpublished; the node honours `Retry-After` and retries shed requests, but a sustained overload surfaces as an error.
- Connections to external warehouses are configured on the Hotdata side, outside RocketRide's view.

## Examples

`examples/db_hotdata.pipe` — Chat → Hotdata → Answers/Table, with Anthropic bound as the SQL-writing LLM.

An agent flow: `load_data` the rows, `build_index` on the text column, then `get_data` with a question, or `execute` a query using `bm25_search`.

## Upstream docs

- [Hotdata API reference](https://www.hotdata.dev/docs/api-reference) and [OpenAPI spec](https://www.hotdata.dev/openapi.yaml)
- [Core concepts](https://www.hotdata.dev/docs/core-concepts-overview)

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `apikey is required` / `workspace_id is required` | Neither the config field nor the env var is set |
| `raw SQL execution is disabled` | Turn on `allow_execute`, or use `get_data` instead |
| `only one statement per call` | Hotdata rejects semicolon-separated batches |
| Unknown function errors | A Postgres-only function that DataFusion lacks — check `dialect` |
| `still shedding load after ...s (HTTP 429)` | Sustained back-pressure; retry later or reduce concurrency |
| Empty results from a fresh run | The database starts empty every run — `load_data` first |

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `hotdata.allow_destructive_load` | `boolean` | **Allow destructive loads**<br/>Permit load_data to use replace, update or delete modes, which overwrite or remove existing rows. Off by default: load_data is append/upsert only, so an agent cannot destroy data another pipeline step loaded. | `false` |
| `hotdata.allow_execute` | `boolean` | **Allow direct query execution**<br/>Permit trusted callers to submit raw read-only SQL. | `false` |
| `hotdata.api_url` | `string` | **API URL**<br/>Hotdata API base URL. Leave empty for https://api.hotdata.dev. | `""` |
| `hotdata.apikey` | `string` | **API Key**<br/>Hotdata API key. | `""` |
| `hotdata.async_after_ms` | `integer` | **Run asynchronously after (milliseconds)**<br/>Wait this long before a query continues as an asynchronous job. | `5000` |
| `hotdata.db_description` | `string` | **Database description**<br/>Schema and domain hints for natural-language SQL generation. | `""` |
| `hotdata.job_timeout_secs` | `integer` | **Job timeout (seconds)**<br/>Maximum time to wait for an asynchronous query. | `300` |
| `hotdata.max_attempts` | `integer` | **Maximum attempts**<br/>Maximum SQL-generation attempts. | `3` |
| `hotdata.max_execute_rows` | `integer` | **Maximum execute rows**<br/>Maximum rows returned by raw SQL execution. | `25000` |
| `hotdata.table` | `string` | **Table**<br/>Table that rows arriving on the answers lane are loaded into. Created on first use. | `"pipeline_data"` |
| `hotdata.ttl` | `string` | **Database lifetime**<br/>Crash-safety expiry for the ephemeral database. | `"24h"` |
| `hotdata.workspace_id` | `string` | **Workspace ID**<br/>Hotdata workspace ID. | `""` |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/db_hotdata)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
