# hackjudge_store

The system of record for the Hack Judge suite: accounts, targets, runs, results,
balances and usage events, read and written from inside the pipeline.

## What it does

Every other Hack Judge node computes; this one remembers. It owns the Postgres
schema the suite shares and exposes tenant-scoped CRUD over it. In the verify
flow it persists each verdict as it arrives and forwards the envelope to token
settlement, so a run survives restarts and disconnects.

Tenant isolation is structural: every query is scoped by the `tenant_id`
resolved upstream by `hackjudge_account`. Asking for another tenant's target or
run does not return "forbidden", it returns "not found", exactly as if the row
did not exist.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `questions` | `answers` | JSON op in, JSON result out |
| `questions` | `questions` | Verify-flow envelope, forwarded to the next stage |

## Ops

| Op | Does |
| --- | --- |
| `targets_list` / `targets_create` / `targets_update` / `targets_delete` | Target definitions (the product being judged) |
| `runs_create` / `runs_finish` / `runs_list` / `runs_get` | Verification runs and their lifecycle |
| `results_append` | Persist one repository's verdict into a run |
| `balance_get` | Read the tenant's prepaid KB balance |
| `usage_append` | Record a metering event |

Records addressed to other verify-flow stages pass through untouched; after
persisting a verdict the node stamps `next: "settle"` and forwards.

## Config

| Field | Meaning |
| --- | --- |
| `database_url` | Postgres connection string. Blank falls back to `HACKJUDGE_DATABASE_URL` only; the node refuses to start without one |

## Schema

The suite's shared DDL ships with this node as `schema.sql` (idempotent;
identical copies ship with the other hackjudge DB nodes so each PR is
self-contained). Apply once per environment:

```
psql "$HACKJUDGE_DATABASE_URL" -f schema.sql
```

## Validation

Covered by the 12-check in-engine suite (run create, result append, verdict
read-back, balance reads) and the 21-repo acceptance run in which every verdict
was persisted through this node and matched the production server row for row.
