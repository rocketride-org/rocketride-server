# hackjudge_account

Business-account sign-in for the Hack Judge suite: resolves who is asking and
which tenant they belong to, entirely inside the pipeline.

## What it does

Hack Judge is a B2B product; every request must map to a paying tenant before
any work runs. This node owns that mapping: it creates accounts, signs users in
and out, validates session tokens, and serves profile reads and updates. In the
verify flow it runs first, stamps the resolved `tenant_id` and `tier` into the
envelope, and forwards to the token gate. An invalid or expired session
short-circuits: the answer goes straight back out and nothing downstream runs.

Security choices, deliberately boring:

- Passwords are hashed with `hashlib.scrypt` (stdlib, no extra dependency),
  parameters recorded in the stored hash so they can be raised later.
- Session tokens are returned to the caller once and stored only as SHA-256
  hashes; a database leak does not leak usable sessions.
- Sessions expire after `session_ttl_hours` and can be revoked with `signout`.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `questions` | `answers` | JSON op in, JSON result out |
| `questions` | `questions` | Verify-flow envelope, enriched and forwarded to the next stage |

## Ops

| Op | Does |
| --- | --- |
| `signup` | Create a tenant + first user, returns a session token |
| `signin` | Verify credentials, returns a fresh session token |
| `validate` | Resolve a session token to `tenant_id`, user and tier |
| `signout` | Revoke the session |
| `profile_get` | Read the account profile |
| `profile_update` | Update company / profile details |

Records addressed to other stages of the verify flow (`{"flow": "verify",
"next": "..."}` where `next` is not `account`) pass through untouched.

## Config

| Field | Meaning |
| --- | --- |
| `database_url` | Postgres connection string (the shared Hack Judge store) |
| `session_ttl_hours` | Session lifetime; expired sessions fail `validate` |

## Validation

Covered by the 12-check in-engine suite (signup, validate, tier resolution)
and the full-chain verify pipeline including the short-circuit paths.
