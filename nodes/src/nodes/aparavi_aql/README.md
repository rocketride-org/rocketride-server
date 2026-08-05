# aparavi_aql

A RocketRide tool node that lets an AI agent query the Aparavi data governance platform in plain English using AQL (Aparavi Query Language).

## What it does

Translates natural-language questions into AQL SELECT statements, executes them against
the Aparavi REST API, and returns file-metadata rows from the Aparavi **STORE** table.
The agent never needs to know AQL or the schema: it just asks a question, and the node
handles schema knowledge, query generation, and execution internally.

AQL generation is delegated to a connected LLM node via the node's required **`llm`**
invoke connection. The full STORE column schema is fixed (no dynamic introspection) and
is injected into the LLM prompt together with AQL syntax rules and few-shot examples.

Execution goes over HTTP using the **requests** library: `POST /server/api/v3/database/query`
on the configured Aparavi server with HTTP Basic Auth, a 30-second timeout, and a default
row limit of 250. Timestamp columns returned in milliseconds are normalized to seconds.

Safety behavior: every generated query is checked before it touches the network. Only a
single SELECT statement is allowed; multi-statement input is rejected, and the keywords
`INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `EXEC`, `EXECUTE`
are blocked anywhere in the query. A query that fails the safety check returns an error
immediately. If LLM generation or execution fails, the node makes up to 3 attempts in
total, feeding the failed AQL and the server's error message back to the LLM so it can
correct the query.

This is a pure tool node: it defines no pipeline lanes and is used only through its
agent-callable tools.

---

## Configuration



| Field | Type | Description |
|---|---|---|
| `url` | string | Default empty. Base URL of the Aparavi server, e.g. https://aparavi.example.com |
| `user` | string | Default empty. Aparavi login username |
| `password` | string | Aparavi login password |
| `db_description` | string | Default empty. What is this data used for? Describe its content and purpose, this helps the LLM generate more accurate AQL queries. |
| `profile` | string | Default "default".  |



The node has a single preconfig profile (`default`).

### Invoke connections

| Connection | Min | Description |
|------------|-----|-------------|
| `llm`      | 1   | LLM used to generate AQL queries from natural language. |

---

## Available tools

### get_data

The primary tool for all Aparavi data retrieval. Takes a natural-language `question`
(required string), generates AQL via the connected LLM, runs the safety check, executes
the query, and returns:



| Tool | Description |
|---|---|---|
| `get_data` | Translate natural language to AQL, execute against Aparavi, and return rows. |
| `get_aql` | Convert a natural-language question to an AQL SELECT statement without executing it. Use only when the user explicitly asks to see the query. |
| `get_schema` | FALLBACK ONLY: returns the fixed column schema for the Aparavi STORE table. Do NOT call this preemptively; only use if get_data fails or returns unexpected results. |



### get_aql

Converts a natural-language `question` (required string) to an AQL SELECT statement
without executing it. Returns `{ "aql": "<query>" }`. Intended only for when the
user explicitly asks to see the query.

### get_schema

Fallback only: returns the fixed column schema for the STORE table as
`{ "store": "STORE", "columns": [{ name, type, description }, ...] }`. Column types are
`STRING`, `NUMBER`, `DATE`, or `OBJECT`. Agents are instructed not to call this
preemptively; it exists for when `get_data` fails or returns unexpected results.

---

## AQL generation

The LLM prompt enforces these rules when generating queries:

- `STORE` is the only table, no JOINs.
- Structure: `SELECT cols FROM STORE [WHERE cond] [WHICH CONTAIN 'term'] [GROUP BY col] [HAVING cond] [ORDER BY col ASC|DESC] [LIMIT n]`.
- `LIMIT 250` is added unless the user specifies a different limit.
- Size units are supported in conditions: `10 MB`, `5 GB`, `100 KB`.
- Date functions: `NOW()`, `TODAY()`, `YEAR()`, `MONTH()`, `DAY()`. `NOW()` returns seconds since the Unix epoch; DATE columns are compared in seconds (e.g. last 30 days = `NOW() - (30 * 86400)`).
- Aggregates (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`), string functions (`UPPER`, `LOWER`, `TRIM`, `LENGTH`, `SUBSTR`, `CONCAT`), `CAST`, and `CASE WHEN` are available.
- Column aliases are always double-quoted to avoid reserved-word conflicts, e.g. `COUNT(*) AS "count"`.

The LLM is instructed to output only the raw AQL string; any accidental markdown fences
are stripped from the response before the safety check runs.

Example generations:

```sql
-- "Find all PDF files larger than 10 MB"
SELECT name, parentPath, size, modifyTime FROM STORE WHERE extension = 'pdf' AND size > 10 MB LIMIT 250

-- "Count files by extension"
SELECT extension, COUNT(*) AS "count" FROM STORE GROUP BY extension ORDER BY "count" DESC LIMIT 250

-- "Files modified in the last 7 days"
SELECT name, parentPath, size, modifyTime FROM STORE WHERE modifyTime > NOW() - (7 * 86400) LIMIT 250
```

---

## STORE schema

The schema is hard-coded in `aql_schema.py` (mirroring Aparavi's server column
definitions) and covers roughly 100 columns: identity (`objectId`, `uniqueId`,
`dupKey`), file attributes (`name`, `parentPath`, `extension`, `size`, `mimeType`),
timestamps (`createTime`, `modifyTime`, `accessTime`, all in Unix epoch seconds),
document and email metadata, cost and storage metrics (`storageCost`, `dupCount`, `dri`),
paths, tags, datasets, classifications, ownership and permissions, audit messages,
search and classification hits, and 0/1 status flags (`isContainer`, `isDeleted`,
`isObject`, `isIndexed`, `isClassified`, `isSigned`).

Timestamp normalization: values in `createTime`, `modifyTime`, `accessTime`,
`docCreateTime`, `docModifyTime`, `instanceMessageTime`, and `objectMessageTime` larger
than 10^10 are treated as milliseconds and divided by 1000, so results are always in
epoch seconds.

---

## Authentication

The node authenticates to the Aparavi server with HTTP Basic Auth using the configured
`user` and `password` on every API request. Credentials are held in memory for the
lifetime of the pipeline and released when it ends.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `aparavi.db_description` | `string` | **Data description**<br/>What is this data used for? Describe its content and purpose, this helps the LLM generate more accurate AQL queries. | `""` |
| `aparavi.password` | `string` | **Password**<br/>Aparavi login password |  |
| `aparavi.profile` | `string` |  | `"default"` |
| `aparavi.url` | `string` | **Aparavi Server URL**<br/>Base URL of the Aparavi server, e.g. https://aparavi.example.com | `""` |
| `aparavi.user` | `string` | **Username**<br/>Aparavi login username | `""` |

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/aparavi_aql)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
