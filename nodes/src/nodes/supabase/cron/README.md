# cron

The Supabase Cron service of the `supabase` node: agent tools that list, inspect, create and remove scheduled SQL jobs (pg_cron) in a Supabase project. Pick it when an agent should look after recurring database work such as nightly clean-ups.

## About Supabase

Supabase is a hosted backend platform built on PostgreSQL. Supabase Cron is the pg_cron extension inside the project's database: each job is a schedule plus a SQL command that the database runs at those times.

## What it does

The service has no data lanes; it is used only as an agent tool. It connects to the project's Postgres pooler, always over TLS, and calls pg_cron's own functions and tables (`cron.schedule`, `cron.unschedule`, `cron.job`, `cron.job_run_details`) with bound parameters only. Every call first checks that pg_cron is installed and sets a 30-second statement timeout.

## As a tool

Tool names are the bare function names below; an agent sees each one as `<component-id>.<function>`. Messages from the node name a function `supabase_cron.<function>`, for example `supabase_cron.schedule_job`. A call above the node's **Access level** is refused with a message naming the level to set.

| Function | Description |
|---|---|
| `list_jobs` | List the jobs (no arguments). Returns `jobs` (`job_id`, `name`, `schedule`, `command`, `active`, `database`, `username`) ordered by `job_id`, `count`, and `truncated`. At most **Max rows** jobs. Below `admin` every string literal in `command` is shown as `'***'`; at `admin` only keys and tokens are (see Notes). Needs `read`. |
| `job_runs` | Recent runs of one job, newest first (`job_name`, optional `limit`, default 20, capped at **Max rows**). Returns `job_name`, `job_id`, `runs` (`run_id`, `status`, `return_message`, `start_time`, `end_time`), `count`, `truncated`. Keys and tokens in `return_message` are replaced by `***`. Needs `read`. |
| `schedule_job` | Create or replace a job (`name`, `schedule`, `sql`). Returns `job_id`, `name`, `schedule`, `replaced`. Needs `admin`. |
| `unschedule_job` | Remove a job by `name`. Returns `name`, `job_id`, `unscheduled`. Needs `admin`. |

`schedule` is standard cron syntax in UTC (`0 3 * * *` is 03:00 every day) or `<1-59> seconds`. Scheduling a name that already exists replaces that job, and `replaced` says so. An invalid schedule fails with pg_cron's own message. `job_runs` and `unschedule_job` fail when no job has that name. `truncated` is true when more rows existed than were returned. Names are at most 255 characters and schedules at most 100.

## Configuration

Paste the **Session pooler** details and keep **Access level** at `read` unless the agent must create or remove jobs.

### Access level

Two levels: `read` (default): `list_jobs` and `job_runs`. `admin`: also `schedule_job` and `unschedule_job`. `schedule_job` stores SQL written by the caller, which pg_cron later runs as the database user (on Supabase usually `postgres`) with no further checks, so give `admin` only to agents you trust with that. Cron has no `write` level, because no Cron function needs it; a `write` written into a pipeline file by hand stops the node at start-up with a message naming the two levels.

### Max rows

Default 100, 1 to 1000. The most jobs `list_jobs` returns and the most runs `job_runs` returns.

### Pooler connection

Host `aws-0-<region>.pooler.supabase.com`, optionally with `:port` (5432 when none is given), user `postgres.<project-ref>`, the database password and database `postgres`. The connection always uses TLS (`sslmode=require`) and SCRAM password authentication (`require_auth=scram-sha-256`), so the password is never sent in clear text, even to a server that pretends to be the pooler. The server certificate is not checked against a CA (`verify-full` is not used).

## Authentication

The database password is in the Supabase dashboard under Project Settings -> Database. This service does not use the project's API keys.

## Notes

### Turning on pg_cron

pg_cron must be enabled in the project (Integrations -> Cron, or Database -> Extensions -> pg_cron). Until it is, every tool fails with a message that says how to turn it on.

### Keys inside job SQL

A job that calls an Edge Function or a webhook with `net.http_post` usually stores a key in its command, for example `headers := '{"Authorization": "Bearer <key>"}'`. That key is often a secret or `service_role` key, which can do far more than this node's level allows, and keys come in too many shapes to recognise them all. So:

- Below `admin`, `list_jobs` shows every string literal in a command as `'***'` (also `$$...$$` bodies and comments). The shape of the SQL stays readable, for example `select net.http_post(url := '***', headers := '***'::jsonb)`, but no value in it does.
- At `admin` (which can schedule any SQL anyway), `list_jobs` shows the command with secret-shaped text replaced by `***`: `sb_secret_` keys, JWTs, bearer tokens (also `'Bearer ' || '<token>'`), the values of headers or fields whose name contains `authorization`, `apikey`, `secret`, `token`, `signature` or `password` (as JSON or as `jsonb_build_object` arguments), conninfo `password=` values and token-like URL query parameters.
- `job_runs` is free text, so `return_message` gets the same pattern masking at every level.

A key in another form is not recognised at `admin` or in `return_message`; keep keys out of job SQL (read them from Vault inside the job) when possible.

## Upstream docs

- [Supabase Cron](https://supabase.com/docs/guides/cron)
- [pg_cron](https://github.com/citusdata/pg_cron)
