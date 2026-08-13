# Shipped example bundles — screenshot checklist

Every migrated node has its `example.pipe` committed. Each still needs
`example.png` and the README block below to complete its bundle
(`docs/development/node-readme-schema.md`, section 3).

For each node:

1. Open the node's `example.pipe` on the canvas.
2. Frame the whole pipeline and save the capture as `example.png` in the
   same directory.
3. Paste the block below into `## Example pipelines`, directly under
   that node's first flow line.
4. `python3 scripts/validate-node-readme.py nodes/src/nodes/<node>` — the
   bundle warning turns into passes.

The block is identical for every node except the alt text. `agent_llamaindex`
is already complete — its entry below is the reference.

---

**`nodes/src/nodes/agent_deepagent`** — `chat → agent_deepagent → response_answers`, with `llm_anthropic` on `llm` and `tool_http_request` on `tool`

```markdown
<div align="center">

![The Deep Agent node on the canvas with an LLM and an HTTP Request tool connected](example.png)

[![Download example.pipe](https://img.shields.io/badge/example.pipe-Download-41b6e6?style=for-the-badge)](example.pipe)

</div>
```

**`nodes/src/nodes/agent_llamaindex`** — `chat → agent_llamaindex → response_answers`, with `llm_anthropic` on `llm` and `tool_http_request` on `tool`

```markdown
<div align="center">

![The agent_llamaindex node on the canvas with an LLM and an HTTP Request tool connected](example.png)

[![Download example.pipe](https://img.shields.io/badge/example.pipe-Download-41b6e6?style=for-the-badge)](example.pipe)

</div>
```

**`nodes/src/nodes/db_postgres`** — `chat → db_postgres → response_answers + response_table`, with `llm_anthropic` on `llm`

```markdown
<div align="center">

![The PostgreSQL node on the canvas answering questions from chat, with an LLM connected](example.png)

[![Download example.pipe](https://img.shields.io/badge/example.pipe-Download-41b6e6?style=for-the-badge)](example.pipe)

</div>
```

**`nodes/src/nodes/llm_anthropic`** — `chat → llm_anthropic → response_answers`

```markdown
<div align="center">

![The Anthropic node on the canvas between a chat source and an answers response](example.png)

[![Download example.pipe](https://img.shields.io/badge/example.pipe-Download-41b6e6?style=for-the-badge)](example.pipe)

</div>
```

**`nodes/src/nodes/ocr`** — `webhook → parse → ocr → ner → anonymize_text → response_text`

```markdown
<div align="center">

![The OCR node on the canvas extracting text from parsed documents in a redaction pipeline](example.png)

[![Download example.pipe](https://img.shields.io/badge/example.pipe-Download-41b6e6?style=for-the-badge)](example.pipe)

</div>
```

**`nodes/src/nodes/store_qdrant`** — the full RAG pipeline: ingest via `webhook → parse → preprocessor_langchain → embedding_transformer → qdrant`, query via `chat → embedding_transformer → qdrant → prompt → llm_openai → response_answers`

```markdown
<div align="center">

![The Qdrant node on the canvas storing embedded documents and serving retrieval for a RAG pipeline](example.png)

[![Download example.pipe](https://img.shields.io/badge/example.pipe-Download-41b6e6?style=for-the-badge)](example.pipe)

</div>
```

**`nodes/src/nodes/tool_github`** — `chat → agent_rocketride → response_answers`, with `llm_anthropic` on `llm` and `tool_github` on `tool`

```markdown
<div align="center">

![The GitHub node on the canvas connected to an agent as a tool](example.png)

[![Download example.pipe](https://img.shields.io/badge/example.pipe-Download-41b6e6?style=for-the-badge)](example.pipe)

</div>
```

---

## Provenance

Three bundles are existing, working pipelines copied from `examples/`:

| Node | Source |
|---|---|
| `agent_llamaindex` | `examples/agent-llamaindex.pipe` |
| `ocr` | `examples/document-processor.pipe` |
| `store_qdrant` | `examples/rag-pipeline.pipe` |

The other four were authored from those proven shapes and are statically
validated — every provider is a declared node protocol, every input lane is
one the upstream node actually produces, and every control channel is one
the target declares in `invoke`. They have **not been executed**. Opening
each on the canvas for its screenshot is the verification step; if one does
not load cleanly, fix it there rather than trusting this file.

Delete this file once every bundle is complete.
