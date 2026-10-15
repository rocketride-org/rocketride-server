# Cypher → Apache AGE translation layer

Apache AGE cannot run bare Cypher: every query needs an SQL `cypher()`
envelope, a synthesized result-column list, prepared-statement parameter
binding, and agtype result decoding — plus a firewall and a dialect gate for
the version gaps. This package is that translation, as a **pure transform**
(no database access), so graph nodes targeting the RocketRide cloud data-core
(PG16 + AGE 1.5.0) can speak Cypher end to end.

## Pipeline

`translate(cypher, params, limit, mode, graph_name, age_version, firewall)`
→ [`TranslatedQuery`](emit.py):

1. **Parse** ([analysis.py](analysis.py)) — openCypher ANTLR grammar (M23),
   not regex. Extracts RETURN projection, write clauses, `$params`,
   variable-length depth bounds, invoked functions.
2. **Firewall** ([firewall.py](firewall.py)) — resource caps on **both**
   paths (query length, variable-length depth, statement timeout, size of the
   bound `$parameter` JSON — values bound as params skip the parser and the
   query-length cap; a prepared statement survives ROLLBACK, so the caller
   frees it inside the transaction when EXECUTE fails, see
   `TranslatedQuery.prepared_name`); semantic
   read-only rules (no writes, no CALL) on the **safe** path only.
3. **Dialect** ([capabilities.py](capabilities.py)) — capability table keyed
   by AGE version: `SUPPORTED` / `EMULATE` (same-meaning rewrite, re-analyzed
   before emit) / `REJECT` (fail loud pre-flight) / `TBD` (unverified: passes through,
   AGE's own error surfaces via EXPLAIN/execute). Verify TBD cells against
   the live instance and promote them.
4. **Emit** ([emit.py](emit.py)) — `cypher()` envelope with a
   collision-proof dollar-quote tag, synthesized `AS (c0 agtype, …)` list,
   `SET LOCAL search_path`/`statement_timeout` preamble, and — when params
   are present — `PREPARE …(agtype)` / `EXECUTE …(%s::agtype)` /
   `DEALLOCATE` (AGE rejects inline `::agtype` literals as the params
   argument).
5. **Decode** ([decode.py](decode.py)) — agtype text → plain Python via the
   vendored Apache AGE driver parser; vertices/edges/paths flatten to dicts.

The caller (the `rocketride_graph` node) executes `TranslatedQuery.statements`
in order inside one transaction — `BEGIN READ ONLY` on the safe path — and
decodes rows with `decode_row`. Everything is `SET LOCAL` because the cloud
endpoint is a transaction-mode pooler: plain `SET` would bleed across tenants.

Errors: `AgeTranslationError` (parse/emit), `AgeUnsupportedFeature`
(capability REJECT), `AgeFirewallRejected` (caps/semantics) — all fail loud.

## Verified AGE 1.5.0 mechanics

Probed against a container on the live pin (PG 16.14 + AGE 1.5.0 + pgvector
0.8.0, image `apache/age:release_PG16_1.5.0` + pgvector v0.8.0):

- AS-list column **count** must equal the RETURN count (names arbitrary);
  no-RETURN statements accept one synthesized column and yield 0 rows.
- `RETURN *` requires scope analysis to synthesize columns → REJECT in v1.
- cypher()'s third argument must be a **prepared-statement parameter**
  (inline `'…'::agtype` fails: "third argument of cypher function must be a
  parameter").
- `age` is in `shared_preload_libraries` → no `LOAD 'age'` needed.
- `EXPLAIN` works over the envelope (incl. `EXPLAIN EXECUTE`) and surfaces
  Cypher syntax errors cleanly — that is the `_validate_query` mechanism.
- `BEGIN READ ONLY` blocks writes through `cypher()` server-side ("cannot
  execute CREATE TABLE in a read-only transaction").
- `datetime()` does not exist on 1.5.0 (`ag_catalog.age_datetime` missing)
  → capability REJECT.
- `SET` / `REMOVE` / `DELETE` reach only the **first** entity a `MERGE`
  creates in a statement; changes to every other entity a MERGE creates are
  **not stored** while `RETURN` shows them: the 2nd and later rows of an
  `UNWIND` or multi-row `MATCH`, the entity of a second MERGE, the far node and
  the edge of a path MERGE (an edge a MERGE creates never keeps a SET), and
  repeated SETs on a created node. Entities a MERGE *matched*, variables bound
  before the first MERGE, and properties inside the MERGE pattern are stored.
  → capability REJECT (`merge_write`): after the first MERGE, a write may only
  target a variable bound before it, or the node of a single-node MERGE that
  opens the query while no `MATCH`/`UNWIND`/`CALL` has multiplied rows (one
  row, so it is the first entity created). The bulk-upsert form is MERGE, then
  a separate `UNWIND $rows ... MATCH ... SET` call.
- MERGE matches on every property in its pattern: with an edge `{prop: 1}`
  already present, `MERGE (a)-[:REL {prop: 2}]->(b)` creates a second edge. So
  the rejection message points to a separate `SET` call first.
- An empty-list `x IN []` (also `[ /*c*/ ]`, `([])`) matches every row; under
  `NOT`, `AND` or in `RETURN` it fails with `cache lookup failed for type 0`.
  An empty list passed as a `$parameter` evaluates correctly → capability
  EMULATE (`empty_list_in`), rewritten to `false`; the query keeps its
  `$parameter` names, so a removed `$who IN []` does not break the params check.
- `UNWIND $rows AS r MERGE (:L {id: r.id})` creates one node per row even
  when rows repeat a key (MERGE does not see nodes created earlier in the
  same statement): de-duplicate the list before binding it.

Both gaps above have canary tests in `nodes/test/test_rocketride_graph_full.py`
that run the shape on AGE directly: when a canary fails after an AGE upgrade,
the gap is fixed upstream and its capability cell can go.

## Vendored code

| Path | Origin | License |
|---|---|---|
| `_cypher/Cypher.g4` + `_cypher/gen/` | openCypher **M23** grammar artifact (`https://s3.amazonaws.com/artifacts.opencypher.org/M23/Cypher.g4`), parser generated with ANTLR 4.13.2 | Apache-2.0 (© Neo Technology 2015-2023) |
| `_agtype/` (`builder.py`, `models.py`, `exceptions.py`, `Agtype.g4`) | `apache/age` master `drivers/python/age/` + `drivers/Agtype.g4` at commit `5a254d6869d8b2c271f025ea158c0fee2cfacfa3` (PyPI `apache-age-python` 0.0.7 is stale and hard-pins antlr 4.11.1 — deliberately not a dependency) | Apache-2.0 |
| `_agtype/gen/` | regenerated from `Agtype.g4` with ANTLR 4.13.2 (upstream ships 4.11-generated code that warns per-parse under the 4.13 runtime) | Apache-2.0 |

Local deviations are documented in each `_agtype`/`_cypher` `__init__.py`
(notably: dropped `_agtype/exceptions.py`'s `from psycopg.errors import *`
psycopg-v3 re-export).

Runtime dependency: `antlr4-python3-runtime>=4.13.2,<4.14`
(declared in `packages/ai/src/ai/common/requirements.txt`).

## Regenerating the parsers

Only needed when a grammar file changes. Requires the pip package
`antlr4-tools` (auto-downloads the ANTLR jar; needs a JRE — `install-jdk`
can fetch one without touching the system):

```bash
antlr4 -v 4.13.2 -Dlanguage=Python3 -visitor -o _cypher/gen _cypher/Cypher.g4
antlr4 -v 4.13.2 -Dlanguage=Python3 -visitor -o _agtype/gen _agtype/Agtype.g4
# then: delete the *.interp/*.tokens artifacts, restore gen/__init__.py,
# and normalize the "Generated from <abs path>" headers to bare filenames.
```

## Deliberately out of scope (v1)

- ~~Capability cell values for `merge_on_set`, `where_label_check`,
  `multi_label`, `shortest_path`~~ — **verified 2026-07-28** against the exact
  pin container (PG 16.14 + AGE 1.5.0): all four fail at AGE's parser
  (`syntax error at or near ...`) while plain `MERGE` on the same graph
  succeeds, so all four are promoted to `REJECT` with actionable messages.
  No `TBD` cells remain in the 1.5.0 table.
- Capability routing to FalkorDB/Neo4j for AGE-can't-do workloads (own
  effort, per the design).
