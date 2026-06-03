# Pipeline Nodes

A node is the unit you build pipelines from. Each one does a single job (parse a
document, call an LLM, store embeddings, transcribe audio) and you chain them
together through their service definitions.

Every node is declared in one or more `services*.json` files under
`nodes/src/nodes/<node>/`. A single directory may register **several services**
(for example `core`, `webhook`, `remote`, `agent_crewai`, and `index_search`
each expose multiple variants), which is why the catalog below lists **services**
rather than directories.

> This catalog is generated from the `services*.json` definitions on `develop`
> (88 node directories → 118 services). For node testing, see
> [README-node-testing.md](README-node-testing.md).

---

## How nodes connect

Nodes connect in **two different ways**, and knowing which is which is the
difference between a pipeline that runs and one that doesn't, whether you wire it
by hand or hand the job to an LLM.

### 1. Data flow: typed lanes

Most nodes exchange data over **lanes**. A lane is a typed port: a node declares
which lane types it **consumes** (inputs) and which it **produces** (outputs) in
its `lanes` block. Two nodes are wire-compatible when an **output lane type of
the upstream node matches an input lane type of the downstream node**.

The complete lane-type ontology and who produces / consumes each type:

| Lane type   | Produced by | Consumed by | Meaning                                            |
| ----------- | :---------: | :---------: | -------------------------------------------------- |
| `questions` |     17      |     39      | A query/prompt envelope flowing toward a model     |
| `answers`   |     36      |      6      | A model/agent response                             |
| `documents` |     29      |     23      | Chunked/embeddable document records                |
| `text`      |     23      |     15      | Plain text                                         |
| `table`     |     10      |      5      | Structured/tabular data                            |
| `image`     |      6      |     10      | Image payloads                                     |
| `audio`     |      4      |      3      | Audio payloads                                     |
| `video`     |      3      |      6      | Video payloads                                     |
| `tags`      |      3      |      3      | Metadata/markers attached to records               |
| `_source`   |      0      |      5      | Entry lane of **source** nodes (external triggers) |

A typical RAG flow chains these types end to end:
`webhook (_source → questions)` → `embedding_openai (questions → questions)` →
`pinecone (questions → documents)` → `prompt (documents → questions)` →
`llm_openai (questions → answers)` → `response (answers → -)`.

### 2. Tool binding: agents and tools

Nodes whose `classType` is `tool` (and a few infrastructure nodes) **have no data
lanes**. They do not sit in the data flow. Instead they **attach to an agent node's
tool channel** and are invoked on demand by the agent. A tool is agent-agnostic:
the same `tool_github` or `tool_tavily` can attach to `agent_deepagent`,
`agent_langchain`, `agent_crewai`, or `agent_rocketride`.

> Rule of thumb: if a node has lanes, **wire** it into the flow. If it is a `tool`,
> **bind** it to an agent. Mixing these up produces an invalid pipeline.

---

## Catalog

### LLM Providers

| Service          | Data flow (in → out) | Description                                  |
| ---------------- | -------------------- | -------------------------------------------- |
| `llm_openai`     | questions → answers  | OpenAI GPT models                            |
| `llm_anthropic`  | questions → answers  | Anthropic Claude models                      |
| `llm_gemini`     | questions → answers  | Google Gemini models                         |
| `llm_bedrock`    | questions → answers  | Amazon Bedrock foundation models             |
| `llm_ollama`     | questions → answers  | Locally-hosted models via Ollama             |
| `llm_mistral`    | questions → answers  | Mistral AI models                            |
| `llm_deepseek`   | questions → answers  | DeepSeek models                              |
| `llm_minimax`    | questions → answers  | MiniMax models                               |
| `llm_qwen`       | questions → answers  | Alibaba Qwen via DashScope                   |
| `llm_xai`        | questions → answers  | xAI Grok models                              |
| `llm_perplexity` | questions → answers  | Perplexity Sonar (web-search models)         |
| `llm_gmi_cloud`  | questions → answers  | GMI Cloud models                             |
| `llm_baidu_qianfan` | questions → answers | Baidu Qianfan / ERNIE (OpenAI-compatible Qianfan API) |
| `llm_openai_api` | questions → answers  | Any OpenAI-compatible endpoint (also ships a Nebius Token Factory preset) |

> `nodes/src/nodes/llm_ibm_watson/` exists but currently ships **no service
> definition** (`services*.json`); it is not registered in the canvas. See
> [open items](#open-items).

### Agents

| Service             | Data flow (in → out) | Description                                                |
| ------------------- | -------------------- | --------------------------------------------------------- |
| `agent_rocketride`  | questions → answers  | Native wave-planning agent built on the RocketRide engine |
| `agent_langchain`   | questions → answers  | Single-agent execution using LangChain                    |
| `agent_crewai`      | questions → answers  | CrewAI agent: standalone, hierarchical manager, and managed sub-agent variants |
| `agent_deepagent`   | questions → answers  | Deep Agents: single-agent and managed sub-agent variants |

### Agent Tools

Tool nodes (`classType: ["tool"]`) expose capabilities to agents over the tool
channel; they have no data lanes and **bind to an agent** (see
[Tool binding](#2-tool-binding--agents-and-tools)).

| Service             | Description                                                       |
| ------------------- | ---------------------------------------------------------------- |
| `tool_tavily`       | Tavily real-time web search                                      |
| `tool_exa_search`   | Exa semantic web search                                          |
| `tool_firecrawl`    | Firecrawl web-scraping operations                                |
| `tool_http_request` | Arbitrary HTTP requests, "curl for agents"                      |
| `tool_github`       | GitHub repository operations                                     |
| `tool_git`          | Local Git repository operations                                  |
| `tool_filesystem`   | File-system access                                               |
| `tool_python`       | Executes Python in a restricted in-process sandbox               |
| `tool_pipe`         | Exposes an inline pipeline as a tool                             |
| `tool_mcp_client`   | Connects to an external (or Butterbase) MCP server's tools       |
| `tool_chartjs`      | Generates Chart.js v4 chart configs from data via the LLM        |
| `tool_bland_ai`     | Places and manages AI phone calls via Bland AI                   |
| `tool_xtrace_memory`| Long-term shared agent memory, backed by xTrace Memory Manager   |
| `tool_mem0`         | Long-term shared agent memory, backed by the hosted Mem0 Platform |

### Embeddings

| Service                 | Data flow (in → out)                         | Description                       |
| ----------------------- | -------------------------------------------- | --------------------------------- |
| `embedding_openai`      | documents, questions → documents, questions  | OpenAI text embeddings            |
| `embedding_transformer` | documents, questions → documents, questions  | Local transformer text embeddings |
| `embedding_image`       | documents, image → documents                 | Image embeddings                  |
| `embedding_video`       | video → documents                            | Video embeddings (frame-based)    |

### Vector Databases & Stores

| Service             | Data flow (in → out)                                | Description                  |
| ------------------- | --------------------------------------------------- | ---------------------------- |
| `chroma`            | documents, questions → answers, documents, questions | Chroma DB                    |
| `pinecone`          | documents, questions → answers, documents, questions | Pinecone                     |
| `milvus`            | documents, questions → answers, documents, questions | Milvus                       |
| `qdrant`            | documents, questions → answers, documents, questions | Qdrant                       |
| `weaviate`          | documents, questions → answers, documents, questions | Weaviate                     |
| `astra_db`          | documents, questions → answers, documents, questions | Astra DB (DataStax)          |
| `atlas`             | documents, questions → answers, documents, questions | MongoDB Atlas Vector Search  |
| `vectordb_postgres` | documents, questions → answers, documents, questions | PostgreSQL pgvector          |
| `index_search`      | text, documents, questions → answers, documents, questions, text | Elasticsearch and OpenSearch (BM25 + vector) |

### Databases

| Service         | Data flow (in → out)               | Description                                  |
| --------------- | ---------------------------------- | -------------------------------------------- |
| `db_postgres`   | answers, questions → answers, table, text | PostgreSQL and Supabase (insert + NL-to-SQL) |
| `db_mysql`      | answers, questions → answers, table, text | MySQL                                        |
| `db_clickhouse` | questions → answers, table, text   | ClickHouse (NL-to-SQL)                       |
| `db_neo4j`      | questions → answers, table, text   | Neo4j graph database                         |

### Document Processing

| Service                  | Data flow (in → out)   | Description                                  |
| ------------------------ | ---------------------- | -------------------------------------------- |
| `llamaparse`             | tags → table, text     | LlamaParse document parser                   |
| `reducto`                | tags → table, text     | Reducto document parser                      |
| `preprocessor_langchain` | table, text → documents | LangChain text splitters / chunking          |
| `preprocessor_llm`       | table, text → documents | LLM-based summarization / key-point chunking |
| `preprocessor_code`      | text → documents       | Source-code tokenization                     |

> Generic parsing and content hashing are also provided by the **`core`** module
> (see [Core module](#core-module)).

### Text & Analysis

| Service         | Data flow (in → out)                       | Description                                  |
| --------------- | ------------------------------------------ | -------------------------------------------- |
| `question`      | text → questions                           | Wraps input text into a Question envelope    |
| `prompt`        | documents, text, table, questions → questions | Merges multiple inputs into one question  |
| `extract_data`  | table, text → answers, documents           | Extracts structured data from text           |
| `ner`           | text, documents → documents, text          | Named Entity Recognition                     |
| `anonymize`     | text → text                                | PII detection and redaction                  |
| `summarization` | text → documents, text                     | Summaries and key points                     |
| `dictionary`    | text → documents                           | Extracts a dictionary of key terms           |

### Image

| Service                  | Data flow (in → out)        | Description                                  |
| ------------------------ | --------------------------- | -------------------------------------------- |
| `llm_vision_openai`      | image, documents → documents, text | OpenAI vision models (analysis, OCR)  |
| `llm_vision_gemini`      | image, documents → documents, text | Google Gemini vision models           |
| `llm_vision_mistral`     | image, documents → documents, text | Mistral vision models                 |
| `llm_vision_ollama`      | image, documents → documents, text | Local vision models via Ollama        |
| `accessibility_describe` | image → text                | Scene descriptions for accessibility         |
| `ocr`                    | documents, image → table, text | Optical character recognition             |
| `image_cleanup`          | image → image               | Image preprocessing (grayscale, denoise) for OCR |
| `thumbnail`              | image, documents → documents, image | Thumbnail generation                 |

### Audio

| Service            | Data flow (in → out)                        | Description                                  |
| ------------------ | ------------------------------------------- | -------------------------------------------- |
| `audio_transcribe` | audio, video → text                         | Speech-to-text transcription                 |
| `audio_tts`        | text, documents, questions, answers → audio | Text-to-speech (Kokoro-82M)                  |
| `audio_player`     | audio, video → -                            | Plays audio on the system output device      |

### Video

| Service         | Data flow (in → out)                | Description                          |
| --------------- | ----------------------------------- | ------------------------------------ |
| `frame_grabber` | video → documents, image, table     | Extracts frames from video           |
| `twelvelabs`    | video → text                        | TwelveLabs video understanding       |

### Sources

| Service    | Data flow (in → out)                              | Description                                  |
| ---------- | ------------------------------------------------- | -------------------------------------------- |
| `webhook`  | _source → questions / tags / audio, image, text, video … | HTTP intake: chat, dropper, and ADS variants |
| `telegram` | _source → audio, image, tags, text, video         | Telegram Bot message source                  |

> Filesystem and cloud connector sources (Google Drive, OneDrive, SharePoint,
> Slack, Confluence, SMB, S3, Azure Blob, GCS, …) are provided by the **`core`**
> module (see [Core module](#core-module)).

### Memory

| Service             | Data flow (in → out)                 | Description                                  |
| ------------------- | ------------------------------------ | -------------------------------------------- |
| `memory_persistent` | questions, answers → answers, questions | Cross-session persistent memory           |
| `memory_internal`   | - (agent tool)                       | Run-scoped keyed memory exposed as agent tools |

### Safety, Reranking & Search

| Service         | Data flow (in → out)                                  | Description                                  |
| --------------- | ----------------------------------------------------- | -------------------------------------------- |
| `guardrails`    | questions, answers, documents → answers, documents, questions | Input/output safety guardrails       |
| `rerank_cohere` | questions → answers, documents                        | Cohere Rerank for retrieval quality          |
| `search_exa`    | questions → answers, text                             | Direct Exa web search (non-tool)             |

### Outputs & Routing

| Service             | Data flow (in → out)                                          | Description                                  |
| ------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| `response`          | text, table, documents, questions, answers, audio, video, image → - | Returns results to the requesting client (per-type variants) |
| `text_output`       | text → -                                                     | Writes text to the file system               |
| `local_text_output` | text → -                                                     | Writes text to a local file                  |
| `remote`            | - (transport)                                                | Forwards data to a remote machine / node (client + server) |
| `autopipe`          | - (composite)                                                | Combines parse + preprocess + embed in one node |

---

## Core module

The `core` module (`nodes/src/nodes/core/`) is not a single node, it registers a
family of built-in services through several `services.common.*.json` files:

- **Sources / connectors:** local filesystem, S3, Azure Blob, Google Drive,
  OneDrive, SharePoint, Outlook, Gmail, Confluence, Slack, SMB.
- **Processing:** document parsing, content hashing/fingerprinting, ZIP creation,
  word indexing, and vectorization helpers.

These are configured through pipeline service definitions rather than as
standalone catalog nodes.

---

## Open items

- `llm_ibm_watson` ships no `services*.json` and is not registered, confirm
  whether it is in progress or should be removed.

---

## Adding a New Node

1. Create a directory in `nodes/src/nodes/<node_name>/`.
2. Implement the required interfaces:

   ```python
   # nodes/src/nodes/my_node/__init__.py
   from .my_node import MyNode
   from .IInstance import IInstance
   from .IGlobal import IGlobal

   # nodes/src/nodes/my_node/my_node.py
   class MyNode:
       def __init__(self, config):
           self.config = config

       def process(self, input_data):
           # Process data
           output_data = input_data
           return output_data
   ```

3. Add a `services.json` (or `services.<variant>.json`) node definition. This is
   where you declare `classType`, `capabilities`, the `lanes` block (which makes
   the node wire-compatible with others), and the `fields` / `shape` config schema
   the canvas renders.
4. Drop the node icon SVG next to `services.json` and reference it by filename:

   ```json
   {
     "icon": "my_node.svg"
   }
   ```

   The build pipeline auto-discovers every `nodes/src/nodes/<node>/*.svg`, no
   central registry to update. It also inspects each SVG and:

   - If the SVG is **monochrome** (one distinct fill/stroke color), it auto-rewrites
     the color to `currentColor` so the icon inherits the active light/dark theme
     color. Author the SVG in whichever single color you like (commonly `#000`);
     the theme handles re-tinting.
   - If the SVG is **multicolor** (two or more distinct colors, a gradient, or a
     pattern), it passes through unchanged and renders in its authored colors. Use
     this for brand logos.

   No theme flag, no manifest list to maintain.

5. Add `requirements.txt` for dependencies.
6. Optionally add a `test` section to `services.json` for automated testing (see
   [README-node-testing.md](README-node-testing.md)).

---

## Prototyping Local Nodes

Develop a node in your own workspace -- next to your `.pipe` -- without changing
the installed engine. Set `--node_path` to the directory that holds your
`local_nodes` folder (the folder name is required):

```sh
engine --node_path=/path/to/dir-containing-local_nodes ...
```

Its nodes are scanned like the built-in ones but imported as `local_nodes.<node>`
(set this in each `services.json` `"path"`), so they never clash with the
built-in `nodes` package.

```text
my-workspace/
└── local_nodes/
    ├── __init__.py          # empty -- just marks local_nodes as a package
    └── my_node/
        ├── __init__.py      # required -- runs depends(requirements.txt) and exports IGlobal/IInstance (see "Adding a New Node")
        ├── services.json    # "path": "local_nodes.my_node"
        ├── IGlobal.py
        ├── IInstance.py
        └── requirements.txt
```

Build the node exactly as in [Adding a New Node](#adding-a-new-node) -- its
`IGlobal` installs the node's own `requirements.txt`, so dependencies work the
same as any built-in node.

To ship a node so it becomes part of RocketRide, clone the
[rocketride-server](https://github.com/rocketride-org/rocketride-server) repo,
move your node into `nodes/src/nodes/<node>/`, change its `services.json`
`"path"` to `nodes.<node>`, and open a pull request following the
[contributing guide](../CONTRIBUTING.md).

---

## License

MIT License, see [LICENSE](../LICENSE).
