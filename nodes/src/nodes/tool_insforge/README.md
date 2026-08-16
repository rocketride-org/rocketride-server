# tool_insforge

A RocketRide agent-tool node that exposes an [InsForge](https://insforge.dev) project's REST API to agents.

## What it does

InsForge is an open-source backend platform — Postgres with row-level security, auth, storage, edge functions and realtime. This node binds to an agent's tool channel and lets it query and modify the project's records, call database functions, and work with stored files.

It has **no data lanes**. Like every `classType: ["tool"]` node it is *bound* to an agent (`agent_rocketride`, `agent_langchain`, `agent_crewai`, `agent_deepagent`), not wired into the pipeline flow.

Talks to the documented REST surface (`/api/database`, `/api/storage`) over `requests`, using the shared retry helpers for backoff on timeouts and 429 / 5xx.

### Why not the PostgreSQL node?

`db_postgres` handles Supabase as a branded preset because Supabase exposes a real Postgres connection string. A managed InsForge project does not — its documented database surface is a PostgREST-style REST API, so there is nothing for `psycopg` to dial. This node speaks that API instead.

If you run **self-hosted** InsForge and have direct access to its Postgres, `db_postgres` and `store_postgres` already work against it and may suit you better for bulk pipeline work.

---

## Configuration

### Lanes

None. This is a tool node.

### Fields

| Field         | Type / Default   | Description                                                                 |
|---------------|------------------|-----------------------------------------------------------------------------|
| `project_url` | string           | Project base URL, e.g. `https://your-app.insforge.app`. Falls back to `ROCKETRIDE_INSFORGE_URL`. |
| `api_key`     | string, secure   | API key or JWT, sent as a Bearer token. Falls back to `ROCKETRIDE_INSFORGE_KEY`. |
| `allow_writes`| boolean, `false` | Permit the mutating tools. Off by default.                                  |

The project URL is normalised to its origin, so pasting a trailing slash or an `/api` suffix from the dashboard is fine.

---

## Tools

### Read — always available

| Tool | Description |
|---|---|
| `records_select` | Query rows from a table with filters, column selection, ordering and paging |
| `storage_list_buckets` | List the project's storage buckets |
| `storage_list_objects` | List objects in a bucket, with metadata and URLs |
| `storage_get_download_url` | Get a direct or presigned download URL for an object |

### Write — require `allow_writes`

| Tool | Description |
|---|---|
| `records_insert` | Insert rows, returning what was inserted |
| `records_upsert` | Insert rows, merging duplicates on a conflict key |
| `records_update` | Update the rows matching a filter |
| `records_delete` | Delete the rows matching a filter |
| `rpc_call` | Call a Postgres function exposed by the project |
| `storage_delete_object` | Delete a stored object |

`rpc_call` is gated with the writes even though many functions only read: nothing in a function's name reveals whether it mutates, so it is treated as a write.

Database tools return a uniform `{count, rows, query}` envelope, so an agent gets the same shape whichever one it called.

### Filters

Filters use PostgREST's convention, expressed as an object mapping a column to an `operator.value` string:

```json
{ "status": "eq.active", "views": "gte.100" }
```

Supported operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `is`. Use `{"id": "in.(1,2,3)"}` for set membership and `{"deleted_at": "is.null"}` for null tests.

The column, the operator, and the presence of a value are all checked before the request goes out, as are the two operator-specific shapes: `in` must carry a parenthesised set, and `is` must name `null`, `true`, `false`, or `unknown`. Each failure names the offending column instead of being silently dropped. The *value* of the other operators is passed through for Postgres to interpret, so a type mismatch surfaces as a `422` from the server rather than a local error.

---

## Safety

- **Read-only by default.** `allow_writes` is off, so binding this node to an agent cannot change the backend until an operator opts in.
- **No unfiltered writes.** `records_update` and `records_delete` refuse to run without at least one filter — PostgREST applies an empty filter set to *every* row, so an omitted filter would rewrite or empty the whole table.
- **Path-safe identifiers.** Table, bucket and function names must be bare Postgres-style identifiers; object keys may be path-like but reject `..` segments and are URL-escaped per segment. No agent-supplied value can redirect a request off the configured host.
- **Row-level security still applies.** The node has exactly the access the supplied credential has. Prefer a scoped key over an admin one.
- **Inserts are not retried.** Row-creating requests bypass the retry helper, since a retried insert would silently duplicate rows.
- Storage downloads return a **URL rather than file bytes**, keeping large binaries out of the conversation.

---

## Error handling

HTTP failures are mapped to messages an agent can act on rather than raw stack traces:

- `401` — "InsForge rejected the credentials. Check the API key or JWT."
- `403` — "The key may lack permission, or a row-level security policy blocked it."
- `404` — "Check the table, bucket, or object key."
- `422` — "Check column names and value types."
- `429` / `5xx` — retried with exponential backoff on `GET`, `PATCH`, `DELETE`, and `PUT`, then surfaced as retryable. `POST` is exempt, for the reason under Safety above: a retried insert or RPC call would duplicate work, so its failures are surfaced on the first attempt.

A missing project URL or key fails at pipeline start with a node-specific message, and shows as a configuration warning in the editor.

---

## Not covered

- **File upload.** The current API negotiates uploads through a multi-step `upload-strategy` handshake whose response shape could not be verified against a live project; the single-call `PUT` alternative is deprecated upstream. Left out rather than guessed at.
- **Vector / pgvector search.** InsForge runs pgvector in-database but exposes no vector or embedding REST endpoints, so a store node would have to go through the admin raw-SQL endpoint. Use `store_postgres` against a self-hosted deployment if you need this.
- **The AI / model gateway.** Deprecated upstream in favour of calling OpenRouter directly; `llm_openai_api` already presets arbitrary OpenAI-compatible endpoints.
- **Auth, payments, messaging, analytics.** No clear agent or pipeline use case yet.

---

## Upstream docs

- [InsForge REST API](https://docs.insforge.dev/sdks/rest/overview)
- [Database records API](https://docs.insforge.dev/sdks/rest/database)
- [Storage API](https://docs.insforge.dev/sdks/rest/storage)
