# hackjudge_account

Marketplace identity resolver for the Hack Judge suite: turns the platform's
signed-in user into the app's tenant + tier, inside the pipeline.

## What it does

Identity is the platform's job, not the app's. A marketplace app declares
`authenticated: true` in its manifest and the platform hands it the signed-in
user at launch: no per-app OAuth client, no password store, no session
machinery in the app (see the app owner runbook).

What the pipeline still needs is the step this node provides. Hack Judge keeps
its own tenant rows (data isolation, tier, prepaid balance), so somebody has
to map "platform org X, platform user Y" onto "app tenant T with tier D" the
moment a request enters the pipeline, and refuse requests that arrive without
a platform identity. That mapping is this node:

- First sight of a platform org creates the app tenant (and its balances row),
  keyed by `marketplace_org_id`.
- First sight of a platform user creates the app user row, keyed per org, so
  one person in two orgs is two app users with separate data and balances.
- The resolved `tenant_id`, `user_id` and `tier` are stamped into the
  verify-flow envelope for every downstream node (token gate, engine, store).
- A request with no platform identity short-circuits: the answer goes straight
  back out and nothing downstream runs.

Tier is read from the tenant row, not decided here: entitlement
(`app_subscriptions` via platform billing) owns which tier an org is on.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `questions` | `answers` | JSON op in, JSON result out |
| `questions` | `questions` | Verify-flow envelope, enriched and forwarded to the next stage |

## Ops

| Op | Does |
| --- | --- |
| `resolve` | Map platform org + user to `tenant_id`, `user_id`, `tier` (creating both on first sight) |
| `profile_get` | Read the account profile |
| `profile_update` | Update company / member display details |

Records addressed to other stages of the verify flow (`{"flow": "verify",
"next": "..."}` where `next` is not `account`) pass through untouched.

## Config

| Field | Meaning |
| --- | --- |
| `database_url` | Postgres connection string. Blank falls back to `HACKJUDGE_DATABASE_URL` only; the node refuses to start without one (no generic `DATABASE_URL` fallback, so it can never write into an unrelated database) |

## Schema

The suite's shared DDL ships with this node as `schema.sql` (idempotent;
identical copies ship with hackjudge_store and hackjudge_tokens so each PR is
self-contained). Apply it once per environment:

```
psql "$HACKJUDGE_DATABASE_URL" -f schema.sql
```

The unique indexes on `tenants.marketplace_org_id` and `users.external_id` are
load-bearing: first-sight creation uses `INSERT ... ON CONFLICT` against them
so concurrent first logins converge on one row.

## Validation

Covered by the suite's in-engine run (tenant resolution, tier stamping) and
the full-chain verify pipeline including the short-circuit paths. Offline
tests cover the pre-DB identity validation, the per-org user keying and the
op surface.
