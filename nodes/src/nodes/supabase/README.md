# supabase

A RocketRide node family for Supabase: database questions and SQL, user management, file storage, vector search, messaging, Edge Functions and scheduled jobs, each as its own service. Pick it when your data or users live in a Supabase project.

## About Supabase

Supabase is a hosted backend platform built on PostgreSQL. A Supabase project bundles a Postgres database with user authentication, file storage, realtime messaging, background queues, scheduled jobs and serverless Edge Functions, all reachable through one project URL.

## What it does

This parent groups seven services, each a separate node in the canvas:

| Service | Node (protocol) | Used as | Connects with |
|---|---|---|---|
| Database | `db_supabase` | pipeline component and agent tool | its own `postgresdb.*` pooler fields, as before |
| Auth | `tool_supabase_auth` | agent tool | Project URL + secret key |
| Storage | `tool_supabase_storage` | agent tool | Project URL + secret key |
| Vector | `supabase_vector` | vector store and agent tool | Postgres pooler (TLS) |
| Messaging | `tool_supabase_messaging` | agent tool | Project URL + secret key |
| Edge Functions | `tool_supabase_functions` | agent tool | Project URL + secret key |
| Cron | `tool_supabase_cron` | agent tool | Postgres pooler (TLS) |

Database is the former Supabase preset of `db_postgres`, moved here unchanged. Vector is the `store_postgres` pgvector store, connected over TLS. The other five services are built on a shared base (`IGlobal.py`, `IInstance.py`, `supabase_client.py` in this folder) that reads the connection, checks the access level and keeps secrets out of answers and errors. Each service folder has its own README with the full tool contract.

## Connections

| Connection | Required | Description |
|---|---|---|
| `llm` | no | Database only: the LLM that turns a plain-English question into SQL; not needed for raw SQL. |

## Lanes

Only Database and Vector have lanes; the other services are agent tools with no lanes.

| Lane in | Lane out | Description |
|---|---|---|
| `questions` | `table` | Database: turn the question into SQL, run it, return a markdown table. |
| `questions` | `text` | Database: turn the question into SQL, run it, return text. |
| `questions` | `answers` | Database: turn the question into SQL, run it, return answers. Vector: return the matching documents as answers. |
| `answers` | — | Database: insert the structured rows into the configured table. |
| `documents` | — | Vector: store embedded document chunks. |
| `questions` | `documents` | Vector: return the matching documents. |
| `questions` | `questions` | Vector: add the matching documents to the questions. |

## As a tool

Tool names are the bare function names below; an agent sees each one as `<component-id>.<function>`. The service is shown in brackets. Every service except Database has an **Access level** (`read`, the default, `write` or `admin`; Cron has only `read` and `admin`, because no Cron function needs `write`); each function needs the level shown. A function above the node's level is not offered to the agent, and a call to it is refused with a message naming the level to set. Database has no access level: its raw-SQL functions run only with **Allow direct query execution** on.

| Function | Description |
|---|---|
| `get_data` (Database) | Plain-English question to a read-only SQL query; runs it and returns the rows plus the SQL (default 250 rows, `limit` up to 25,000). |
| `get_schema` (Database) | Tables, columns, types, primary and foreign keys, for the whole database or one table. |
| `refresh_schema` (Database) | Re-reads the schema and returns it with a `refreshed_at` timestamp. |
| `get_sql` (Database) | Plain-English question to SQL only; nothing is run. |
| `dialect` (Database) | Returns `{"dialect": "postgres"}`. |
| `execute` (Database) | Runs a raw SQL statement. Only with **Allow direct query execution** on. |
| `begin` (Database) | Opens a transaction and returns a `session_id`. Only with **Allow direct query execution** on. |
| `commit` (Database) | Commits a session. Only with **Allow direct query execution** on. |
| `rollback` (Database) | Rolls a session back. Only with **Allow direct query execution** on. |
| `list_users` (Auth) | One page of users (`page`, `per_page` up to **Users per page**, 50 unless changed); says when more may exist. Needs `read`. |
| `get_user` (Auth) | One user by `user_id`. Needs `read`. |
| `verify_user` (Auth) | Checks a user's `access_token`; returns `valid: true` with the user's id and email, or `valid: false` with a reason. Needs `read`. |
| `create_user` (Auth) | Creates a user without sending email. Needs `write`. |
| `invite_user` (Auth) | Creates the user and emails an invite link. Needs `write`. |
| `generate_link` (Auth) | Makes a `signup`, `magiclink`, `recovery` or `invite` link without sending email. Needs `write`. |
| `update_user` (Auth) | Changes a user's email, phone, password, confirmation, metadata or ban; never role or app_metadata. Needs `write`. |
| `delete_user` (Auth) | Deletes a user, or soft-deletes with `soft_delete`. Needs `admin`. |
| `list_buckets` (Storage) | The project's buckets, up to **List limit**. Needs `read`. |
| `list_files` (Storage) | Files and folders directly inside one folder, with `limit` and `offset`. Needs `read`. |
| `download_file` (Storage) | One file as text or base64 up to **Inline download limit** (256 KB unless changed); a larger file comes back as a signed URL. Needs `read`. |
| `create_signed_url` (Storage) | A temporary download link (`expires_in` 60 to 604800 seconds). Needs `read`. |
| `upload_file` (Storage) | Uploads one file, text or base64, up to **Upload limit** (10 MB unless changed). Needs `write`. |
| `create_bucket` (Storage) | Creates a private or public bucket. Needs `admin`. |
| `delete_file` (Storage) | Deletes up to 1000 paths; returns `deleted` and `not_found`. Needs `admin`. |
| `search` (Vector) | Searches the store for a `query`, with optional `top_k` and metadata `filter`. Needs `read`. |
| `get` (Vector) | Chunks of one document by `object_id`. Needs `read`. |
| `objdir` (Vector) | Distinct parent paths, each with one object ID. Needs `read`. |
| `list_documents` (Vector) | Documents with `object_id`, `parent` and `chunk_count`. Needs `read`. |
| `stats` (Vector) | Row count, document count, embedding model and vector size. Needs `read`. |
| `upsert` (Vector) | Adds or replaces documents; replacing overwrites a stored document's content. Needs `write`. |
| `delete` (Vector) | Deletes documents for good. Needs `admin`. |
| `soft_delete` (Vector) | Moves documents to the trash. Needs `admin`. |
| `restore` (Vector) | Takes documents out of the trash. Needs `admin`. |
| `broadcast` (Messaging) | Sends one Realtime broadcast message to a channel. Needs `write`. |
| `queue_send` (Messaging) | Adds a message to a queue, optionally delayed. Needs `write`. |
| `queue_read` (Messaging) | Reads up to `count` messages and hides them from other readers for `visibility_seconds`. Needs `write`, because reading changes what other readers see. |
| `queue_pop` (Messaging) | Takes the next message and deletes it in one step. Needs `write`. |
| `queue_archive` (Messaging) | Moves a message to the queue's archive. Needs `write`. |
| `queue_delete` (Messaging) | Deletes a message for good. Needs `write`. |
| `invoke_function` (Edge Functions) | Calls a deployed Edge Function and returns its status and response body, cut at **Max response size**. Needs `write`. |
| `list_jobs` (Cron) | The pg_cron jobs, up to **Max rows**. Needs `read`. |
| `job_runs` (Cron) | Recent runs of one job, newest first. Needs `read`. |
| `schedule_job` (Cron) | Creates or replaces a job that runs SQL on a schedule. Needs `admin`. |
| `unschedule_job` (Cron) | Removes a job by name. Needs `admin`. |

No service offers the agent a function above the node's level: it is left out of the tool list, and a direct call is refused. Vector's failures come back as `{"success": false, "error": ...}`, the shape every vector store uses. The other services raise an error with a plain message instead.

## Configuration

### Database

Database keeps the settings of the former Supabase preset of the PostgreSQL node, unchanged, so saved `db_supabase` pipelines keep working: pooler host with port, user, password, database name, optional table and description. Raw SQL (`execute`, `begin`, `commit`, `rollback`) runs only with **Allow direct query execution** on, which is off by default.

### Auth, Storage, Messaging and Edge Functions

Paste the **Project URL** (`https://<project-ref>.supabase.co`; plain `http://` is accepted only for localhost, private IP addresses and private-network names (a name without a dot such as `http://kong:8000`, or one ending in `.internal`, `.local` or `.localhost`), because every call carries the secret key) and a **Secret key** (`sb_secret_...`, from Project Settings -> API Keys). Publishable and anon keys are refused at start-up. The secret key bypasses row-level security, so set **Access level** to the lowest level the agent needs; the default is `read`. Messaging and Edge Functions need `write` for every tool, so at the default `read` they offer the agent no tools at all: set `write` to turn them on (their tiles say "Tools need write or admin", and a node started at `read` writes one warning to the job log). The other fields of each service are limits with working defaults (page size, inline and upload limits, payload and response sizes).

### Vector and Cron

Use the **Session pooler** details from the dashboard's Connect panel: host (for example `aws-0-eu-west-1.pooler.supabase.com:5432`), user `postgres.<project-ref>`, the database password and the database name (`postgres`). The connection always requires TLS. The direct host `db.<project-ref>.supabase.co` is IPv6-only. Vector also needs the `vector` extension, and Cron the `pg_cron` extension, turned on in the project.

## Limitations

Database is declared `noremote`: it runs on the local engine host only, not as remote execution, as the former preset did. Every service needs a network path from the engine host to the Supabase project (its API URL, or its Postgres pooler for Database, Vector and Cron). The secret key and the database password bypass row-level security; the access level is the guard. Only key-based connection is available: there is no "Connect Supabase" sign-in yet.

## Notes

### Moved from db_postgres

`db_postgres/services.supabase.json` moved to `services.database.json` here, with the same protocol, lanes, LLM connection and `postgresdb.*` fields, names and defaults. Its `path` is still `nodes.db_postgres`: the code is `db_postgres`'s own, with no wrapper.

### Reading a whole bucket in a pipeline

There is no Supabase source for reading a whole bucket in this release. The general **Object Storage** source has a URL field (Supabase's S3 endpoint is `https://<project-ref>.storage.supabase.co/storage/v1/s3`, with S3 access keys from Storage settings) but its settings panel has no region field, and it signs for `us-east-1` when no region is given, so only projects in that region are expected to work. This is untested. See the Storage README.

### Setup a service may need

- Messaging queues: turn on **Expose Queues via PostgREST** (Integrations -> Queues -> Settings) and give `service_role` its permissions on each queue.
- Edge Functions: a function deployed with **Verify JWT** on refuses the `sb_secret_` key, because the key is not a JWT. Turn that check off for the functions the agent calls.

## Upstream docs

- [Supabase documentation](https://supabase.com/docs)
- [API keys](https://supabase.com/docs/guides/api/api-keys)
- [Connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)
