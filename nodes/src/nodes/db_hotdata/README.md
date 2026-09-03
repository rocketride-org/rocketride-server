# Hotdata

A database and tool node backed by [Hotdata](https://www.hotdata.dev/) — use a fresh ephemeral database per pipeline run or attach separate runs to one shared database.

## What it does

By default, the first time the node is used it provisions a Hotdata database with a TTL, and `endGlobal` deletes it. That makes it the right choice for scratch work — pull a dataset in, join and aggregate it, emit the answer, leave nothing behind. It can also attach to an existing database when data needs to be shared across pipeline runs.

As a pipeline node it takes natural-language questions on the `questions` lane and emits results on `table` / `text` / `answers`, and it loads structured rows arriving on the `answers` lane. As a tool node an agent drives it directly.

It needs a connected LLM (the `llm` control connection) to translate questions into SQL, in the same way `db_postgres` and `rocketride_sql` do.

## Tools

| Tool          | What it does                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `load_data`   | Load rows, or a previous query result by `result_id`, into a table. Creates the table if needed              |
| `get_data`    | Answer a plain-language question. The bound LLM writes the SQL; failures are retried with the error fed back |
| `get_sql`     | Generate the SQL for a question without running it                                                           |
| `execute`     | Run one raw read-only SQL statement. Gated by `allow_execute`                                                |
| `get_schema`  | Live tables and columns from `information_schema`                                                            |
| `build_index` | Build a `bm25`, `vector` or `sorted` index on a column                                                       |
| `dialect`     | The full SQL dialect briefing — read this before writing SQL by hand                                         |

## Lanes

| Lane        | Direction | Behaviour                                                                                                                                                  |
| ----------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `questions` | in        | Natural-language question, answered and emitted to `table` / `text` / `answers`                                                                            |
| `answers`   | in        | JSON rows, loaded into the configured table. A fenced or prose-wrapped object is unwrapped; `{"rows": [...]}` becomes N rows; text carrying no JSON raises |
| `table`     | out       | Query results as a Markdown table                                                                                                                          |
| `text`      | out       | Query results rendered as text                                                                                                                             |
| `answers`   | out       | Query results as an answer payload                                                                                                                         |

## Setup

Set an API key and workspace ID on the node, or export `HOTDATA_API_KEY` and `HOTDATA_WORKSPACE`. The default endpoint is `https://api.hotdata.dev`.

Wire an LLM to the node's `llm` control connection — without one, natural-language querying cannot work. See `examples/db_hotdata.pipe`.

## Publishing into a shared database

Do not instruct an agent to call `load_data` on a shared database. Measured across two
model families, an agent that reasons correctly and reports the right answer still skips
that call most of the time — it is the third step of an instruction list, and models drop
it. Roughly one in four wrote the row.

Wire the agent's `answers` output into this node's `answers` lane instead. The row is
loaded because the graph says so, not because the model remembered. The agent keeps its
own private database as a thinking tool, and the shared table is written by the pipeline.

The agent's final answer has to be the row: an object, a list of objects, or a
single-key wrapper like `{"rows": [...]}`. Code fences and a sentence of preamble are
tolerated. Anything with no JSON in it raises rather than leaving an empty table.

## Sharing a database between runs

Create the database separately or let one pipeline run create it, then pass its ID to other runs through `database_id` (or `HOTDATA_DATABASE_ID`). Those runs attach to the same database instead of creating their own, so their agents can share tables and query results.

An attached database is never deleted by this node; managing its lifetime, including its TTL, is the caller's responsibility. Attached runs cannot build indexes because a Database API Token cannot retrieve the database's connection ID. Build indexes in the owning run that created the database.

**An attached run assumes the default schema is `main`.** The same 403 that hides the connection ID hides the database's real default schema, so the node cannot read it back. If the owning run created the database with a different default schema, pass `schema` explicitly on `load_data` — otherwise rows land in `main.<table>` and the owning run's queries against its own schema will not see them.

### One table, one row shape

A shared table is written by more than one producer, and Hotdata requires every write to carry the table's full column set — a column left out of an append would be dropped, so the server refuses instead. `load_data` recovers automatically: it reads the table's live columns and fills the absent ones with null before retrying.

That recovery only works while the absent columns are textual. A numeric or temporal column that is null in **every** row of a batch is inferred as text, and the server will not re-type it. There is no payload that satisfies both rules, so give each kind of record its own table rather than sharing one table between records of different shapes.

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
- **Ephemeral data is destroyed when the run ends.** The configured TTL is only a fallback for a crashed engine. Attached databases are left in place.
- With a Database API Token, both `GET /v1/databases/{id}` and `DELETE /v1/databases/{id}` return 403, so attached databases rely on their TTL for cleanup.
- **Writes to one table are serialized server-side.** A second concurrent writer is refused
  with `409 RESOURCE_LOCKED` ("retry shortly"). The node replays those — the request is
  rejected before doing any work, so a replay cannot double-load — but a shared table is a
  queue, not a parallel write path. Measured against the live API, 8 simultaneous appends to
  one table landed 1 without retries and 12 of 12 with them, the slowest taking 6 attempts
  over 12s. Publish latency grows with the number of concurrent publishers; give each agent
  its own table, or its own database, when that matters.
- Rate limits are dynamic and unpublished; the node honours `Retry-After` and retries shed requests, but a sustained overload surfaces as an error.
- Connections to external warehouses are configured on the Hotdata side, outside RocketRide's view.

## Examples

`examples/db_hotdata.pipe` — Chat → Hotdata → Answers/Table, with Anthropic bound as the SQL-writing LLM.

An agent flow: `load_data` the rows, `build_index` on the text column, then `get_data` with a question, or `execute` a query using `bm25_search`.

## Upstream docs

- [Hotdata API reference](https://www.hotdata.dev/docs/api-reference) and [OpenAPI spec](https://www.hotdata.dev/openapi.yaml)
- [Core concepts](https://www.hotdata.dev/docs/core-concepts-overview)

## Troubleshooting

| Symptom                                           | Cause                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `apikey is required` / `workspace_id is required` | Neither the config field nor the env var is set                                                         |
| `raw SQL execution is disabled`                   | Turn on `allow_execute`, or use `get_data` instead                                                      |
| `only one statement per call`                     | Hotdata rejects semicolon-separated batches                                                             |
| Unknown function errors                           | A Postgres-only function that DataFusion lacks — check `dialect`                                        |
| `still shedding load after ...s (HTTP 429)`       | Sustained back-pressure; retry later or reduce concurrency                                              |
| `still locked by another writer after ...s`       | Too many agents appending to one table for the job timeout; raise `job_timeout_secs` or split the table |
| Empty results from a fresh run                    | The database starts empty every run — `load_data` first                                                 |

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
