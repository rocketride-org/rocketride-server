# hackjudge_tokens

The commercial core of the Hack Judge suite: prepaid KB balances, checked
before work starts and settled after it finishes. A customer can only ever use
what they have already paid for.

## What it does

Hack Judge is prepaid and metered: verification is billed by the KB of source
code actually scanned. This node enforces the four rules of that model:

1. Prepaid only. Tokens enter a balance through `credit`; there is no credit
   line and no invoice-after-use.
2. Metered in real time. `hackjudge_engine` reports `kb_processed` for every
   repository; `settle` deducts it as runs complete.
3. Hard stop at zero. `gate` refuses the next run the moment the balance is
   empty.
4. Never negative. Settlement clamps at zero and reports the shortfall; a
   balance below zero cannot be represented, not merely avoided.

One node class serves both ends of the run. The pipeline wires two instances
and the `role` config field decides which stage each one answers to: the
`gate` instance runs after account resolution and before the engine, the
`settle` instance runs after the store has persisted the verdict.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `questions` | `answers` | JSON op in, JSON result out |
| `questions` | `questions` | Verify-flow envelope, forwarded to the next stage |

## Ops

| Op | Does |
| --- | --- |
| `gate` | Check the balance before a run; blocked answer short-circuits the flow |
| `settle` | Deduct actual `kb_processed` after a run, clamped at zero |
| `credit` | Add prepaid KB to a tenant's balance (billing is the only caller) |
| `config` | Set refill target / thresholds for a balance |
| `balance` | Read the current balance |

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
| `role` | `gate` or `settle`: which verify-flow stage this instance answers |

## Validation

Covered by the 12-check in-engine suite (gate blocks at zero, credit, gate
admits when funded, settle deducts the exact KB the engine metered) and by the
21-repo acceptance run, which settled to the expected balance to the decimal.
