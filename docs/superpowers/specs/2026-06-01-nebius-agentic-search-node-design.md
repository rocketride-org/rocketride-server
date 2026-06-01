# Nebius Agentic Search — Design Spec

**Date:** 2026-06-01
**Author:** Po-Hsu (pohsu.lien@rocketride.ai)
**Status:** Draft — pending review
**Related:** GTM-driven new nodes list (Nebius sponsorship, June 18 event). No GitHub issue yet.

---

## 1. Goal

Deliver a **Nebius Agentic Search** capability: a pipeline where a Nebius-hosted LLM
reasons about a user question, decides what to search, calls Tavily web search one or
more times (refining queries as needed), and synthesizes a grounded, cited answer.

This showcases the full Nebius stack — **Nebius Token Factory (reasoning) + Tavily
(real-time search)** — where Tavily is the agentic-search capability Nebius acquired.

## 2. Approach: compose existing infrastructure (Shape B)

Decision: build the feature the way every existing agent in this codebase is built —
an **agent node driving a wired LLM channel + wired tool channel** — rather than a
self-contained node with a bundled LLM and a hand-rolled tool loop.

**Evidence for this choice:** all four agent nodes (`agent_crewai`, `agent_deepagent`,
`agent_langchain`, `agent_rocketride`) are `classType: ["agent","tool"]` and require an
external `"llm"` invoke channel; `llm_*` nodes are single-purpose inference providers;
`tool_*` nodes are single-purpose tools; `search_exa` is single-shot with no loop. There
is **zero precedent** for a node that bundles its own LLM client and runs an internal
tool-calling loop. Composing existing infra reuses a battle-tested loop and matches the
engine's deliberate architecture (text-only LLM seam + JSON-envelope tool protocol —
documented in `agent_langchain/README.md` and `agent_deepagent/deepagent.py`).

## 3. Background / Facts

- **Nebius Token Factory** (formerly AI Studio): OpenAI-compatible inference at
  `https://api.tokenfactory.nebius.com/v1/`, Bearer auth. Hosts 60+ open models
  (Llama 3.x, Qwen3/2.5, DeepSeek V3, GPT-OSS, Mistral). "Using Nebius" = using this
  inference service; Nebius does not train a proprietary foundation model.
- **Tavily** (Nebius-acquired): "the web access layer for agents" — `POST
  https://api.tavily.com/search`, Bearer `tvly-...`. Response:
  `{ query, results:[{title,url,content,score}], ... }`.
- **"Agentic search" definition** (both vendors): the *search/retrieval layer that
  agents call*, distinct from the reasoning LLM. The agency comes from the LLM driving
  the search — which is exactly what the agent loop provides.

## 4. Deliverables

| # | Item | New/Reuse | Mirrors |
| --- | --- | --- | --- |
| 1 | `tool_tavily_search` node | **NEW** (core work) | `tool_exa_search` (Exa → Tavily) |
| 2 | `llm_nebius` node | **NEW** (branding) | `llm_gmi_cloud` (base_url → Token Factory) |
| 3 | Agentic loop | **REUSE** `agent_deepagent` (default) | — |
| 4 | "Nebius Agentic Search" pipeline template | **NEW** | `examples/*.pipe`, `canvas/templates/templates.json` |

`llm_nebius` is recommended for the on-brand "Nebius" palette entry, but is optional —
the existing `llm_openai_api` node already accepts a custom `base_url`
(`llm_openai_api/services.json:99`) and can point at Token Factory as a zero-new-node
fallback.

### 4.1 `tool_tavily_search` (new tool node)

Clone of `tool_exa_search`. Files: `__init__.py`, `IGlobal.py`, `IInstance.py`,
`services.json`, `requirements.txt` (`requests`), `tavily.svg`, `README.md`.

- `classType: ["tool"]`, `capabilities: ["invoke"]`, `register: "filter"`,
  `lanes: {}` (discovered via the control-plane invoke seam, like `tool_exa_search`).
- One `@tool_function`:
  `tavily_search(query, search_depth?, max_results?, topic?, time_range?,
  include_domains?, exclude_domains?)` — input schema mirrors `tool_exa_search`
  adapted to Tavily params. Output: `{ success, query, num_results, results:[{title,
  url, content, score, published_date?}], error? }`.
- Implementation: `POST https://api.tavily.com/search`, Bearer auth, 30s timeout,
  exponential-backoff retry on 429/5xx (clone `tool_exa_search/IInstance.py:210-257`),
  SSRF guard on result URLs (clone `search_exa/exa_search.py:146-168`).
- API key: `secure`, `ApiKeyWidget`. Resolution: node config → connConfig →
  `os.environ["ROCKETRIDE_TAVILY_KEY"]`.

### 4.2 `llm_nebius` (new LLM provider node)

Clone of `llm_gmi_cloud`. Files: `__init__.py` (exports `getChat`), `IGlobal.py`,
`IInstance.py`, `nebius.py` (`Chat(ChatBase)`), `services.json`, `requirements.txt`
(`langchain-openai`), `nebius.svg`, `README.md`.

- `classType: ["llm"]`, used by agents via the `llm` invoke channel.
- `Chat(ChatBase)` builds
  `langchain_openai.ChatOpenAI(model=<model>, base_url="https://api.tokenfactory.nebius.com/v1/",
  api_key=<nebius>, max_tokens=...)` — same shape as `llm_gmi_cloud/gmi_cloud.py:58-63`.
- Default model: **`meta-llama/Llama-3.3-70B-Instruct`** (strong tool-calling). **Open
  item:** confirm exact Token Factory slug + that the agent loop works against it.
- API key: `secure`, `ApiKeyWidget`. Resolution: node config → connConfig →
  `os.environ["ROCKETRIDE_NEBIUS_KEY"]`.

### 4.3 Reuse `agent_deepagent`

Drives the reasoning/tool loop. `classType: ["agent","tool"]`, invoke channels
`llm: {min 1}`, `tool: {min 0}` (`agent_deepagent/services.agent.json:13-24`). No
changes required. (`agent_rocketride` "Wave" is a viable alternative driver — it batches
parallel tool calls, useful for fan-out multi-source search — but `agent_deepagent` is
the default for simplicity.)

### 4.4 Pipeline template

A `.pipe` example (e.g. `examples/nebius-agentic-search.pipe`) wiring
`llm_nebius` (llm channel) + `tool_tavily_search` (tool channel) + `agent_deepagent`,
with a question/answer endpoint. Optionally register it in
`packages/shared-ui/src/components/canvas/templates/templates.json` so it appears as a
one-click "Nebius Agentic Search" template in the canvas.

## 5. Data flow

```
question ─▶ agent_deepagent (questions lane)
              │  LangGraph loop (existing):
              │   ├─ call host LLM  ──▶ llm_nebius ──▶ Token Factory (Nebius reasoning)
              │   ├─ JSON-envelope tool_call ──▶ tool_tavily_search ──▶ api.tavily.com
              │   └─ feed result back, repeat until {"type":"final"}
              ▼
          answers lane: synthesized, cited answer
```

The loop, host-LLM routing, tool discovery/invocation, and SSE events are all provided
by the existing `agent_deepagent` driver (`deepagent.py`) + `AgentBase`
(`packages/ai/src/ai/common/agent/agent.py`). No loop code is written by us.

## 6. Error handling

Most behavior is inherited from the existing agent loop. New-code responsibilities:

| Condition | Behavior |
| --- | --- |
| Missing Tavily / Nebius key | `IGlobal.beginGlobal()` raises node-specific error; `validateConfig()` warns (matches `tool_exa_search`/`llm_gmi_cloud`). |
| Tavily 401 / Nebius 401 | Provider-prefixed `PermissionError`. |
| Tavily 429 / 5xx | Exponential-backoff retry, then a clear `{success:false, error}` (tool layer must not crash the loop). |
| Timeout / connection error | Mapped to clear errors; tool returns `success:false`. |
| SSRF (private/loopback URLs) | Dropped via `_validate_public_url`. |
| Empty query | Tool returns `success:false` with message (matches `tool_exa_search`). |

## 7. Testing

- **`tool_tavily_search`**: `services.json` `test` block (per `docs/README-node-testing.md`),
  `requires: ["ROCKETRIDE_TAVILY_KEY"]` for full runs + `ROCKETRIDE_MOCK` mock path
  (mock in `nodes/test/mocks/`). Cases: valid query → results notEmpty; empty query →
  `success:false`. Pure helpers (retry, URL validation) unit-tested.
- **`llm_nebius`**: `services.json` `test` block, `requires: ["ROCKETRIDE_NEBIUS_KEY"]`,
  mock path. Case: simple prompt → answer notEmpty (mirrors `llm_gmi_cloud` test).
- **Contract tests** (`builder nodes:test`) validate both nodes' `services.json` +
  module import.
- **Integration**: a smoke test of the template pipeline (mocked) confirming an
  end-to-end question → answer with ≥1 Tavily call.

## 8. Forward compatibility ("leave room")

- `llm_nebius`: profiles let new Token Factory models be added without code changes.
- `tool_tavily_search`: Tavily also offers extract / crawl / research endpoints — each
  can be added later as an additional `@tool_function` on the same node, no rewrite.
- The template composes standard nodes, so swapping the driver (deepagent ↔ Wave) or the
  LLM model is pure configuration.

## 9. Dependencies

`requests` (Tavily tool), `langchain-openai` (Nebius LLM) — both already used in the
repo. Synchronous; no homomorphic crypto, no Python-3.11 constraint, no async bridge.

## 10. Open items

1. Confirm Token Factory model slug for the default (`meta-llama/Llama-3.3-70B-Instruct`?)
   and that the agent loop's JSON-envelope protocol works reliably against it.
2. Build branded `llm_nebius`, or ship with existing `llm_openai_api`? (Spec assumes
   `llm_nebius` for GTM branding.)
3. Default driver in the template: `agent_deepagent` (assumed) vs `agent_rocketride` Wave.
