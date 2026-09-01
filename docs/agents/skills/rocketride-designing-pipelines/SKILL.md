---
name: rocketride-designing-pipelines
description: Use when choosing which RocketRide nodes a task needs and wiring them into a pipeline graph — exploring the node catalog, selecting nodes by archetype, and connecting them with typed lanes into a valid acyclic DAG.
---

# Designing RocketRide Pipelines

Turns a plain-language request into an approved, lane-correct DAG — **before** any node is
configured. Two outputs, two gates: a node selection (Gate A) and a wired topology (Gate B).
The gate rules and forcing functions are in
`../rocketride-building-pipelines/GATE_PROTOCOL.md` — they apply here.

You work from the **node index** (L1): `LAYER1_NODE_INDEX.json` (bundled), or the live
`get_services()` / `.rocketride/services-catalog.json`. Each entry is `name · classType · lanes ·
invoke`. The index is enough to **select and wire**; it carries no config fields (that's Phase 2).
The bundled index is reconciled against this repo's node corpus (`nodes/src/nodes/`), so it can
drift from the set a particular live engine actually has registered.
The live MCP `list_components` tool lists names/summaries only (**no lanes**) and hides nodes whose
integration isn't configured — use it to check availability, but **wire from the bundled index +
per-node schemas**. If a node you expect is missing from it, check `list_integrations` first.

## Phase 1a — Discover (→ Gate A)

1. **Restate the task** in one line: the input data, the wanted output. ("Input: user questions.
   Output: answers grounded in uploaded PDFs.")
2. **Explore archetypes exhaustively.** Group the index by `classType` and walk every archetype
   that could plausibly contribute. Don't stop at the first match. The archetypes:
   `source` (chat/webhook/dropper/filesys/telegram) · `data`/parse (parse/llamaparse/reducto/
   landingai_ade) · `text` (extract_data/ner/anonymize_text/dictionary/prompt/summarization) ·
   `preprocessor` · `image` · `audio` · `video` · `embedding` · `llm` (14 providers) · `store`
   (vector DBs) · `database` (db_*) · `agent` · `tool` (tool_*) · `memory` · `rerank` · `search` ·
   `guard` · `infrastructure`/`target`/`response_*` (terminals).
   For each relevant archetype, list the candidate nodes you see in the index.
3. **Select**, citing each: `Found in index: <name> · classType=[…] · lanes={…}`. A pipeline needs
   exactly one **source** and a **terminal** (`response_*` for a reply; a store / `db_*` for
   ingestion). Pull the right converters from the lane cheat-sheet in
   `../rocketride-building-pipelines/pipeline-patterns.md`.
4. **Gate A** — end with the count line and the gate:
   > Archetypes explored (N). Selected nodes (M): <name · role>, … — all cited from the index.
   > Approve these M nodes? (yes / adjust / cancel)
   Then **use the Write tool to write `.context/GATE_STATE.md`** = `GATE A | presented | status:
   AWAITING` (GATE_PROTOCOL §2 — so the gate survives a context reset), and **STOP**. (See §1.)

## Phase 1b — Design the DAG (→ Gate B)

Only after Gate A is approved.

1. **Fetch each selected node's schema** (L2 — `describe_component` / `tools/` shim in
   `../rocketride-configuring-pipelines/tools/fetch-node-schema.py` / `.rocketride/schema/<n>.json`).
   You need the real **lane signatures** here, not the index summary — wiring from the summary is
   the most common silent bug. (Forcing function 8.) **Lazily — only for the nodes you selected at
   Gate A; never `ls`/`cat`/glob the whole `.rocketride/schema/` dir or "pull every schema up front"
   (FF#17). Select from the index first; fetch only the few schemas you need.**
2. **Wire the lanes.** Each non-source node gets `input: [{lane, from}]`. State **every edge** with
   its lane type: `chat_1 → embedding_1 (lane: questions)`. The output lane of `from` must be a
   real output of that node and a valid input of the target. If types don't match, insert a
   converter (cheat-sheet) — don't force it.
   - `<Bad>`: `pdf_source_1 → store_1 (lane: text)` — wiring a raw document straight into a vector
     store. It passes the eye test but fails validation: a store ingests **embeddings**, not text.
   - `<Good>`: `pdf_source_1 → embedding_1 (lane: text)` then `embedding_1 → store_1 (lane: embeddings)`.
3. **Apply the structural rules** (`PIPELINE_RULES_SUMMARY.md`): exactly one source; acyclic (no
   loops); no orphans (every node reachable from the source); embedding **before** any store;
   agents wire their `llm`/`tool`/`memory` via the **control plane** (the controlled node carries
   `control: [{classType, from: <agent>}]`, the agent does not) and must meet each `invoke`
   min/max from the index.
4. **Draw it** (Mermaid or ASCII) and **Gate B**:
   > <diagram>. Edges (K): <node → node (lane: type)>, … — all lane-checked against schemas.
   > Approve this topology? (yes / adjust / cancel)
   Then **Write `.context/GATE_STATE.md`** = `GATE B | presented | status: AWAITING` (§2), and STOP.

Hand the approved selection + topology to `rocketride-configuring-pipelines`.

## Red flags

| Thought | Reality |
|---|---|
| "I'll list the obvious nodes and move on" | Exhaustive archetype walk first — the right node is often one you'd skip. Count line proves coverage. |
| "The index shows the lanes, I don't need the schema to wire" | Index lanes are a summary; fetch the schema for exact signatures before wiring. |
| "Two sources is fine" | Exactly one source per pipeline. |
| "I'll point the store straight at the questions" | Embedding is required before any store; same model for ingest + query. |
| "The agent node lists its tools in its own config" | No — the tool/llm/memory carries `control: [{from: <agent>}]`. Agent has no control array. |
| "Close enough on the lane type" | Lane mismatch = pipeline error. Insert a converter or pick compatible nodes. |

## Supporting files

- `LAYER1_NODE_INDEX.json` — the thin node index (name · classType · lanes · invoke)
- `PIPELINE_RULES_SUMMARY.md` — lane types, lane-transform table, structural + control-plane rules
- `examples/` — worked pipelines (simple-chat-rag, document-ingestion, agentic-chat) in
  `examples/README.md` + a `FAILURE_SCENARIOS.md` of what not to do
- **deep docs** — when a node is unfamiliar or you're unsure how an archetype behaves, fetch ONE
  page: `../rocketride-building-pipelines/tools/fetch-doc.py "<node-name>"` (→ `/nodes/<name>.md`)
  or `… "execution model"` (→ `/concepts/execution-model.md` for lanes). Never `llms-full.txt`.
