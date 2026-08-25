# Pipeline Rules Summary

**Load this when:** wiring the DAG — lane types, the lane-transform table, and the structural +
control-plane rules.

Condensed from the RocketRide pipeline/component reference. The authoritative source is the live
engine (`validate()`); this is the design-time checklist.

## What a pipeline is
A directed **acyclic** graph of components joined by **typed lanes**, saved as a `.pipe` JSON file.
Exactly one **source**; data flows to a terminal. A connection is valid only when an **output lane
name** of the source node matches an **input lane name** of the target node.

## Lane types
| Lane | Carries |
|---|---|
| `tags` | raw file metadata/bytes (source output) |
| `text` | plain text |
| `table` | structured tables |
| `documents` | chunked docs (optionally with embedding vectors) |
| `questions` | questions to answer (optionally vectorized) |
| `answers` | answers from LLMs / stores |
| `image` / `audio` / `video` | media streams |

## Lane transformations (input → component → output)
| In | Component | Out |
|---|---|---|
| `tags` | parse | `text`, `table`, `image`, `audio`, `video` |
| `text` | preprocessor_langchain | `documents` |
| `text` | question | `questions` |
| `documents` | embedding_* | `documents` (with vectors) |
| `questions` | embedding_* | `questions` (with vectors) |
| `documents` | store (ingest) | — (terminal) |
| `questions` | store (search) | `documents`, `answers`, `questions` |
| `questions` | llm_* | `answers` |
| `image` | ocr / accessibility_describe | `text` |

If two nodes' lanes don't line up, insert the converter that bridges them. `image` cannot go
straight to `questions` — go `image → accessibility_describe → text → question → questions`.

## Structural rules
1. **One source.** Exactly one `source`-classType node (chat / webhook / dropper / filesys /
   telegram). Source nodes have no `input` array.
2. **Acyclic.** No loops anywhere in the data flow.
3. **No orphans.** Every non-source node must be reachable from the source.
4. **Inputs required.** Every non-source node needs an `input: [{lane, from}]` (one entry per
   incoming edge; multiple entries = a merge / fan-in).
5. **Lane compatibility.** Output lane type of one node must match the input lane type of the next.
6. **Embedding before store.** Vector stores cannot accept data without embedding vectors; use the
   **same** embedding model for ingestion and query.
7. **One terminal kind per goal.** Answers/replies end in `response_*` (`response_answers`,
   `response_text`, …). Ingestion ends in the store (no response node needed).

## Control plane (agents, NL-DB, and other `invoke` nodes)
Some nodes don't take their LLM/tool/memory through a data lane — they **invoke** it. The index
`invoke` field declares the requirement (`{llm:{min:1}, tool:{min:0}, memory:{min:1,max:1}}`, etc.).

**The `control` array goes on the CONTROLLED node, pointing back at the invoker — never on the
invoker.** Example (an agent with an LLM, a tool, and memory):
```jsonc
// agent: only data-lane input, NO control array
{ "id": "agent_rocketride_1", "provider": "agent_rocketride",
  "input": [{"lane": "questions", "from": "chat_1"}] }
// the llm declares it is controlled BY the agent:
{ "id": "llm_openai_1", "provider": "llm_openai",
  "control": [{"classType": "llm", "from": "agent_rocketride_1"}] }
// the tool: controlled BY the agent:
{ "id": "tool_http_request_1", "provider": "tool_http_request",
  "control": [{"classType": "tool", "from": "agent_rocketride_1"}] }
// the memory: controlled BY the agent:
{ "id": "memory_internal_1", "provider": "memory_internal",
  "control": [{"classType": "memory", "from": "agent_rocketride_1"}] }
```
A single LLM/tool/memory node may be **shared** by several invokers (add multiple entries to its
`control` array). `agent_rocketride` requires exactly 1 llm and exactly 1 memory; crewai/langchain
agents require ≥1 llm and don't support memory. `db_*` nodes require 1 llm (to craft SQL/Cypher).
Always read the node's `invoke` cardinality in the index and satisfy min/max.

## File shape (for reference; you assemble this in Phase 2)
```json
{
  "components": [ { "id": "...", "provider": "...", "config": {}, "input": [] } ],
  "project_id": "literal-guid-here",
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "version": 1
}
```
`components` is the only required field. `project_id` (a literal GUID), `viewport`, `version`, and
`source` are **optional** in the current schema — keep `components` first and include a literal-GUID
`project_id` as an editor convention, but they aren't hard requirements. The `source` field is
managed by the editor; omit it when hand-writing.

## Freshness notes (reconcile against the live engine / docs)
- **Env substitution:** the engine expands **any** `${VAR}` from the environment (e.g.
  `${OPENAI_API_KEY}`) — a `ROCKETRIDE_` prefix is not required.
- **Response node:** the current docs show a single `response` provider with `config.laneName`
  (e.g. `{ "provider": "response", "config": { "laneName": "answers" } }`). Our bundled catalog
  snapshot still lists lane-specific variants (`response_answers`, `response_text`, …). Use whatever
  the **live index / `get_services()` / `validate()`** confirms for your engine — that's authoritative;
  the bundled examples use `response_answers` to match the bundled catalog.
- **Fan-in:** a node can merge the same lane from several upstream nodes by listing multiple `input`
  entries, e.g. a `response` merging `answers` from two agents:
  `"input": [{"lane":"answers","from":"agent_1"},{"lane":"answers","from":"agent_2"}]`.
