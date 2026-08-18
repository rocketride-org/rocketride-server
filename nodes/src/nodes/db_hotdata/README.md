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
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
