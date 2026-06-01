# Nebius Agentic Search Node — Design Spec

**Date:** 2026-06-01
**Author:** Po-Hsu (pohsu.lien@rocketride.ai)
**Status:** Draft — pending review
**Related:** GTM-driven new nodes list (Nebius sponsorship, June 18 event). No GitHub issue yet.

---

## 1. Goal

Add a single, self-contained pipeline node — **Nebius Agentic Search** — that performs
*multi-step agentic web search*: a Nebius-hosted LLM reasons about a user question,
decides what to search, calls Tavily web search one or more times (refining queries as
needed), and synthesizes a grounded, cited answer.

This showcases the full Nebius stack in one drag-and-drop node:
**Nebius Token Factory (reasoning) + Tavily (real-time search)** — Tavily being the
agentic-search capability Nebius acquired.

## 2. Background / Facts

- **Nebius Token Factory** (formerly AI Studio): OpenAI-compatible inference API at
  `https://api.tokenfactory.nebius.com/v1/`, Bearer auth. Supports native
  OpenAI-style tool/function calling (`tools=`, `tool_choice=`, `message.tool_calls`).
- **Tavily**: web search + content extraction. `POST https://api.tavily.com/search`,
  Bearer `tvly-...`. Response: `{ query, answer?, results:[{title,url,content,score}], ... }`.
- This is the agentic (multi-step loop) variant. A single-shot "search-then-answer"
  was considered and rejected: the deliverable must visibly demonstrate *agentic*
  behavior for the GTM message.

## 3. Architecture

**Shape: self-contained node mirroring `search_exa`, NOT subclassing `AgentBase`.**

Why not `AgentBase`: `AgentHostServices.LLM.__init__`
(`packages/ai/src/ai/common/agent/_internal/host.py:27-37`) hard-requires exactly one
*externally wired* LLM node, and `AgentBase.call_llm` routes through the engine seam
which strips the `tools=` parameter (forcing the JSON-envelope workaround that
`agent_deepagent` had to invent). A self-contained node lets us:
- bundle the Nebius LLM internally (true single-node experience), and
- use **native** Nebius function calling (`response.choices[0].message.tool_calls`) —
  a cleaner, more reliable loop than the JSON-envelope protocol.

The node reuses the proven `search_exa` lifecycle: a `ChatBase` subclass whose
`chat(question) -> Answer` runs the agentic loop internally. `IGlobal` resolves config
+ API keys and constructs the backend; `IInstance` forwards questions to it.

### Component map

| File | Responsibility | Mirrors |
| --- | --- | --- |
| `nodes/src/nodes/nebius_search/__init__.py` | Export `IGlobal`, `IInstance` | `search_exa/__init__.py` |
| `nodes/src/nodes/nebius_search/IGlobal.py` | Resolve config + both API keys; build backend in `beginGlobal()`; `validateConfig()` warns | `search_exa/IGlobal.py` |
| `nodes/src/nodes/nebius_search/IInstance.py` | `writeQuestions` → `IGlobal.search.chat(question)` → `writeAnswers` | `search_exa/IInstance.py` |
| `nodes/src/nodes/nebius_search/nebius_search.py` | `NebiusAgenticSearch(ChatBase)`: the agentic loop, Nebius client, Tavily tool | `search_exa/exa_search.py` + `tool_exa_search` HTTP/retry |
| `nodes/src/nodes/nebius_search/services.json` | Node definition: classType, lanes, profiles, fields, test | `search_exa/services.json` |
| `nodes/src/nodes/nebius_search/requirements.txt` | `openai`, `requests` | — |
| `nodes/src/nodes/nebius_search/nebius.svg` | Icon | — |
| `nodes/src/nodes/nebius_search/README.md` | Usage docs | `search_exa/README.md` |

Provider/protocol name: **`nebius_search`** (broad enough to add facets later;
see §8). `classType: ["search"]`, `capabilities: ["invoke"]`, `register: "filter"`.

## 4. Data flow

```
questions lane ──▶ NebiusAgenticSearch.chat(question)
                      │
                      ▼
            ┌── agentic loop (bounded) ───────────────────────┐
            │ 1. Nebius LLM call with tools=[tavily_search]    │
            │ 2. if message.tool_calls:                        │
            │      for each call → Tavily HTTP → append result │
            │      as a tool-role message → goto 1             │
            │ 3. else: final answer text                       │
            └──────────────────────────────────────────────────┘
                      │
                      ▼
        answers lane  : synthesized answer (string)
        documents lane: cited sources [{title, url, content, score}]
```

`lanes: { "questions": ["answers", "documents"] }`.
The `answers` lane carries the synthesized answer; `documents` carries the
deduplicated source list accumulated across all Tavily calls (so downstream nodes can
render citations).

## 5. The agentic loop (`nebius_search.py`)

- Build an `openai.OpenAI(api_key=<nebius>, base_url="https://api.tokenfactory.nebius.com/v1/")`
  client (pattern precedent: `llm_perplexity` uses `langchain_openai.ChatOpenAI` with a
  custom base_url; here we use the raw `openai` client to get native tool_calls).
- Define one tool exposed to the model:
  `tavily_search(query, search_depth?, max_results?, topic?, time_range?, include_domains?)`
  — schema mirrors `tool_exa_search`'s `@tool_function` input schema, adapted to Tavily.
- Loop, capped at `maxIterations` (config, default 5):
  1. `client.chat.completions.create(model, messages, tools=[...], tool_choice="auto")`
  2. If `choice.message.tool_calls`: execute each via the Tavily HTTP helper, append a
     `{"role":"tool","tool_call_id":...,"content": <json>}` message, accumulate sources,
     continue.
  3. Else: return `choice.message.content` as the answer.
- If the cap is hit before a final answer: make one final no-tools call forcing a
  best-effort answer from gathered context (never loop forever).
- System prompt instructs the model: search when facts are needed, refine queries on
  weak results, cite sources, stop when confident.

### Tavily HTTP helper
Mirror `tool_exa_search._request_with_retry` (`nodes/src/nodes/tool_exa_search/IInstance.py:210-257`):
`POST https://api.tavily.com/search`, Bearer auth, 30s timeout, exponential-backoff
retry on 429 / 5xx. Reuse `search_exa`'s `_validate_public_url` SSRF guard
(`search_exa/exa_search.py:146-168`) on returned URLs.

## 6. Configuration (`services.json`)

- `preconfig.profiles.default`: `{ model: "<token-factory-model-id>", maxIterations: 5,
  searchDepth: "advanced", maxResults: 5 }`. **Open item:** confirm the exact default
  model slug from the Token Factory model list before finalizing.
- Fields:
  - `nebius_search.apikey` — Nebius API key. `secure: true`, `ApiKeyWidget`.
    Resolution order: node config → connConfig → `os.environ["ROCKETRIDE_NEBIUS_KEY"]`.
  - `nebius_search.tavilyApikey` — Tavily API key. `secure: true`, `ApiKeyWidget`.
    Resolution order: node config → connConfig → `os.environ["ROCKETRIDE_TAVILY_KEY"]`.
  - `nebius_search.model` — Nebius model id (string).
  - `nebius_search.maxIterations` — integer 1–10, default 5.
  - `nebius_search.searchDepth` — enum `basic|advanced`, default `advanced`.
  - `nebius_search.maxResults` — integer 1–20, default 5.
- `tile`: show model + maxIterations.
- `shape`: one "Pipe" section grouping the two API keys + profile/params.

## 7. Error handling

| Condition | Behavior |
| --- | --- |
| Missing Nebius or Tavily key | `IGlobal.beginGlobal()` raises a node-specific error; `validateConfig()` emits a warning (matches `search_exa`). |
| Nebius 401 / Tavily 401 | Raise `PermissionError` with provider-prefixed message. |
| 429 / 5xx | Exponential-backoff retry (Tavily helper); surface a clear error after retries. |
| Timeout / connection error | Map to `TimeoutError` / `ConnectionError`. |
| Model emits malformed tool args | Skip that tool call, append an error tool-message so the model can recover; do not crash. |
| `maxIterations` reached | One final no-tools answer attempt; never infinite-loop. |
| Empty question | Raise `ValueError` (matches `search_exa`). |
| SSRF (private/loopback URLs in results) | Drop via `_validate_public_url`. |

## 8. Forward compatibility ("leave room")

Per manager guidance — design so future facets attach without a rewrite:
- Broad provider name `nebius_search`; profile-based config (same extensible pattern as
  `llm_perplexity`).
- Loop, Tavily client, and Nebius client are separate units in `nebius_search.py`, so a
  future "pure Nebius chat" or "embeddings" facet can reuse the client wiring.
- Optionally (not now / YAGNI): expose the loop as a `@tool_function` and add
  `"tool"` to `classType` so a parent agent can call Nebius Agentic Search as a tool —
  mirrors `agent_deepagent/deepagent_agent/IInstance.py:53-90`.

## 9. Testing

- `services.json` `test` block (per `docs/README-node-testing.md`), gated with
  `requires: ["ROCKETRIDE_NEBIUS_KEY", "ROCKETRIDE_TAVILY_KEY"]` for full runs, plus a
  mock path via `ROCKETRIDE_MOCK` (mocks in `nodes/test/mocks/`) so CI runs without keys.
- Cases:
  1. Simple factual question → `answers` notEmpty + `documents` notEmpty (≥1 source).
  2. Multi-hop question (forces ≥2 searches under mock) → answer references both sources.
  3. Empty input → error / graceful handling.
- Contract test (`builder nodes:test`) validates `services.json` structure + module import.
- Pure helpers (query extraction, source dedup, URL validation) unit-tested directly.

## 10. Dependencies

`openai`, `requests` (both already used elsewhere in the repo). Synchronous; no
homomorphic crypto, no Python-3.11 constraint, no async↔sync bridge.

## 11. Open items (confirm before/within implementation)

1. Default Token Factory model slug (verify against Nebius model list).
2. Whether `documents` lane sources should also include Tavily's own `answer` field.
3. Phasing: this spec targets the production agentic node directly (per decision to
   build Shape 2 / option 2). GTM = production node; June 18 = polish.
