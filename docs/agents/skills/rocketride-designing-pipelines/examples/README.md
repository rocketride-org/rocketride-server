# Worked Examples

Three real, validated pipelines. When a request resembles one, **adapt the example** instead of
reasoning from scratch (forcing function 15). Every provider, profile, and lane below is verified
against the node catalog. Always re-verify against the live index/schemas for your engine.

---

## 1. `simple-chat-rag.pipe` — answer questions from indexed docs (RAG)

Request shape: "a chatbot that answers from my knowledge base."

Flow: `chat_1 → embedding_1 → qdrant_1 → llm_1 → response_1`

| Node | provider | lane in → out | why |
|---|---|---|---|
| chat_1 | chat (source) | `_source` → `questions` | conversational input (`client.chat()`) |
| embedding_1 | embedding_transformer | `questions` → `questions` | vectorize the query (profile `miniAll`) |
| qdrant_1 | qdrant (search) | `questions` → `questions` | retrieve context (profile `local`) |
| llm_1 | llm_openai | `questions` → `answers` | answer with context (profile `openai-4o`) |
| response_1 | response_answers | `answers` → — | return the answer |

Notes: the query embedding model must match the one used to ingest the docs. The LLM key is
`${ROCKETRIDE_OPENAI_KEY}`. Ingest the docs first with `document-ingestion.pipe`.

---

## 2. `document-ingestion.pipe` — load docs into the vector store

Request shape: "index these PDFs so I can search them."

Flow: `webhook_1 → parse_1 → preprocessor_1 → embedding_1 → qdrant_1`  (no response node)

| Node | provider | lane in → out | why |
|---|---|---|---|
| webhook_1 | webhook (source) | `_source` → `tags` | file upload (`client.send_files()`) |
| parse_1 | parse | `tags` → `text` | extract text from files |
| preprocessor_1 | preprocessor_langchain | `text` → `documents` | chunk (profile `recursive`) |
| embedding_1 | embedding_transformer | `documents` → `documents` | add vectors (profile `miniAll`) |
| qdrant_1 | qdrant (ingest) | `documents` → — | store (terminal) |

Notes: ingestion ends in the **store** — no `response_*` node. Embedding is mandatory before the
store. Use the **same** embedding profile here and in the RAG query pipeline.

---

## 3. `agentic-chat.pipe` — an agent with an LLM + memory (control plane)

Request shape: "an assistant that can reason and remember." Demonstrates the **control plane** —
the hardest wiring to get right.

Flow (data): `chat_1 → agent_1 → response_1`. Control: `llm_1` and `memory_1` are attached to the
agent via their own `control` arrays.

| Node | provider | wiring | why |
|---|---|---|---|
| chat_1 | chat (source) | → questions | input |
| agent_1 | agent_rocketride | `input: questions from chat_1` | plans + synthesizes |
| llm_1 | llm_openai | `control: [{classType: llm, from: agent_1}]` | the agent's LLM (required, exactly 1) |
| memory_1 | memory_internal | `control: [{classType: memory, from: agent_1}]` | the agent's memory (required, exactly 1) |
| response_1 | response_answers | `input: answers from agent_1` | return the answer |

Notes: the `control` array goes on the **controlled** node (llm/memory), pointing back at the
agent — never on the agent. `agent_rocketride` requires exactly 1 llm and exactly 1 memory; tools
are optional (`tool_*` with `control: [{classType: tool, from: agent_1}]`). Check each agent's
`invoke` cardinality in the index.
