# Pipeline Nodes

Pipeline nodes are modular Python components that extend the engine's data processing capabilities. Each node handles a specific task -- parsing documents, calling an LLM, storing embeddings in a vector database, etc. -- and nodes are composed into pipelines via JSON configuration.

For information on testing nodes, see [README-node-testing.md](README-node-testing.md).

---

## LLM Providers

| Node                 | Description                                | Documentation                                             |
| -------------------- | ------------------------------------------ | --------------------------------------------------------- |
| `llm_openai`         | OpenAI GPT models                          |                                                           |
| `llm_anthropic`      | Anthropic Claude                           |                                                           |
| `llm_gemini`         | Google Gemini                              |                                                           |
| `llm_bedrock`        | AWS Bedrock                                |                                                           |
| `llm_ollama`         | Local Ollama models                        |                                                           |
| `llm_mistral`        | Mistral AI                                 |                                                           |
| `llm_perplexity`     | Perplexity AI (Sonar, web search)          | [README](../nodes/src/nodes/llm_perplexity/README.md)     |
| `llm_deepseek`       | DeepSeek models                            |                                                           |
| `llm_minimax`        | MiniMax models                             |                                                           |
| `llm_xai`            | xAI (Grok)                                 |                                                           |
| `llm_ibm_watson`     | IBM Watson                                 |                                                           |
| `llm_nebius`         | Nebius AI (preset of `llm_openai_api` — defined via `services.nebius.json`, not a separate directory) | [README](../nodes/src/nodes/llm_openai_api/README.md)      |
| `llm_gmi_cloud`      | GMI Cloud models                           |                                                           |
| `llm_qwen`           | Qwen models                                |                                                           |

## Vision Models

| Node                  | Description                                      | Documentation                                             |
| --------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| `llm_vision_gemini`   | Google Gemini Vision (multimodal, image-to-text)  |                                                           |
| `llm_vision_ollama`   | Ollama Vision (multimodal, image-to-text)         |                                                           |
| `llm_vision_openai`   | OpenAI Vision (multimodal, image-to-text)         |                                                           |
| `llm_vision_mistral`  | Mistral Vision (multimodal, image-to-text)        | [README](../nodes/src/nodes/llm_vision_mistral/README.md) |

## Vector Databases

| Node                | Description                 |
| ------------------- | --------------------------- |
| `chroma`            | Chroma DB                   |
| `pinecone`          | Pinecone                    |
| `milvus`            | Milvus                      |
| `qdrant`            | Qdrant                      |
| `weaviate`          | Weaviate                    |
| `astra_db`          | Astra DB (DataStax)         |
| `vectordb_postgres` | PostgreSQL pgvector         |
| `atlas`             | MongoDB Atlas Vector Search |

## Embeddings

| Node                    | Description                  |
| ----------------------- | ---------------------------- |
| `embedding_openai`      | OpenAI embeddings            |
| `embedding_transformer` | Local transformer embeddings |
| `embedding_image`       | Image embeddings             |
| `embedding_video`       | Video embeddings             |

## Document Processing

| Node                     | Description                   | Documentation                                     |
| ------------------------ | ----------------------------- | ------------------------------------------------- |
| `llamaparse`             | LlamaParse document parser    | [README](../nodes/src/nodes/llamaparse/README.md) |
| `reducto`                | Reducto document parser       |                                                   |
| `ocr`                    | Optical character recognition |                                                   |
| `preprocessor_langchain` | LangChain text splitters      |                                                   |
| `preprocessor_llm`       | LLM-based preprocessing       |                                                   |
| `preprocessor_code`      | Code preprocessing            |                                                   |
| `extract_data`           | Structured data extraction    |                                                   |
| `vectorizer`             | Text vectorization            |                                                   |

## AI and Analysis

| Node               | Description              | Documentation                              |
| ------------------ | ------------------------ | ------------------------------------------ |
| `ner`              | Named Entity Recognition | [README](../nodes/src/nodes/ner/README.md) |
| `anonymize`        | PII redaction            |                                            |
| `summarization`    | Text summarization       |                                            |
| `audio_transcribe` | Audio to text (Whisper)  |                                            |
| `guardrails`         | Pipeline guardrails and safety checks |                                  |
| `rerank_cohere`      | Cohere reranking                      |                                  |
| `accessibility_describe` | Accessibility image descriptions  |                                  |

## Media

| Node            | Description            |
| --------------- | ---------------------- |
| `frame_grabber` | Video frame extraction |
| `image_cleanup` | Image preprocessing    |
| `thumbnail`     | Thumbnail generation   |
| `audio_player`  | Audio playback         |
| `audio_tts`     | Text-to-speech synthesis |
| `twelvelabs`    | TwelveLabs video AI      |

## Storage and Connectivity

| Node           | Description               |
| -------------- | ------------------------- |
| `remote`       | S3, Azure Blob, GCS       |
| `db_mysql`     | MySQL database            |
| `index_search` | Elasticsearch, OpenSearch |
| `db_clickhouse` | ClickHouse database       |
| `db_neo4j`      | Neo4j graph database      |
| `db_postgres`   | PostgreSQL database       |
| `search_exa`    | Exa search                |
| `telegram`      | Telegram integration      |

The `core` module provides built-in connectors for OneDrive, SharePoint, Google Drive, Outlook, Confluence, Jira, Slack, SMB, and filesystem sources. These are configured via pipeline JSON rather than as standalone nodes.

## Pipeline Utilities

| Node                | Description                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `question`          | Question routing                                                                            |
| `response`          | Response formatting (text, documents, answers, audio, image, video, table, classifications) |
| `prompt`            | Prompt construction                                                                         |
| `webhook`           | Webhook integration (chat, dropper, ADS)                                                    |
| `autopipe`          | Automatic pipeline routing                                                                  |
| `dictionary`        | Dictionary lookups                                                                          |
| `text_output`       | Text output                                                                                 |
| `local_text_output` | Local text file output                                                                      |
| `memory_internal`   | Internal conversation memory                                                                |
| `memory_persistent` | Persistent conversation memory                                                              |

## Agent Nodes

Agent nodes orchestrate multi-step reasoning with tool use.

| Node                | Description                              |
| ------------------- | ---------------------------------------- |
| `agent_crewai`      | CrewAI multi-agent orchestration         |
| `agent_deepagent`   | DeepAgent autonomous reasoning           |
| `agent_langchain`   | LangChain agent framework                |
| `agent_rocketride`  | Native RocketRide agent                  |

## Agent Tools

Tool nodes (`classType: ["tool"]`) expose capabilities to agents via the control-plane invoke channel rather than data lanes.

| Node                 | Description                             | Documentation                                      |
| -------------------- | --------------------------------------- | -------------------------------------------------- |
| `tool_tavily`        | Tavily real-time web search for agents  | [README](../nodes/src/nodes/tool_tavily/README.md) |
| `tool_bland_ai`      | Bland AI phone call tool                |                                                    |
| `tool_chartjs`       | Chart.js chart generation               |                                                    |
| `tool_exa_search`    | Exa search tool for agents              |                                                    |
| `tool_filesystem`    | Filesystem operations                   |                                                    |
| `tool_firecrawl`     | FireCrawl web scraping                  |                                                    |
| `tool_git`           | Git operations                          |                                                    |
| `tool_github`        | GitHub API operations                   |                                                    |
| `tool_http_request`  | HTTP request tool                       |                                                    |
| `tool_mcp_client`    | MCP client tool                         |                                                    |
| `tool_pipe`          | Pipeline-to-pipeline invocation         |                                                    |
| `tool_python`        | Python code execution                   |                                                    |
| `tool_xtrace_memory` | XTrace memory tool                      |                                                    |

Like any tool node, these are agent-agnostic: they attach to any agent node's tool channel (e.g. `agent_deepagent`, `agent_langchain`, `agent_crewai`).

## Internal

| Node       | Description                                                           |
| ---------- | --------------------------------------------------------------------- |
| `llm_base` | Compatibility wrapper; canonical base is `ai.common.llm_base.LLMBase` |
| `core`     | Core services (cloud connectors, parsing, etc.)                       |

---

## Adding a New Node

1. Create a directory in `nodes/src/nodes/<node_name>/`
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

3. Add `services.json` (or `services.<variant>.json` for branded presets) for the node definition.
4. Drop the node icon SVG next to `services.json` and reference it by filename:

   ```json
   {
     "icon": "my_node.svg",
     ...
   }
   ```

   The build pipeline auto-discovers every `nodes/src/nodes/<node>/*.svg` — no central registry to update. It also inspects each SVG and:

   - If the SVG is **monochrome** (one distinct fill/stroke color), it auto-rewrites the color to `currentColor` so the icon inherits the active light/dark theme color. Author the SVG in whichever single color you like (commonly `#000`); the theme handles re-tinting.
   - If the SVG is **multicolor** (two or more distinct colors, a gradient, or a pattern), it passes through unchanged and renders in its authored colors. Use this for brand logos.

   No theme flag, no manifest list to maintain.

5. Add `requirements.txt` for dependencies.
6. Optionally add a `test` section to `services.json` for automated testing (see [README-node-testing.md](README-node-testing.md)).

---

## License

MIT License -- see [LICENSE](../LICENSE).
