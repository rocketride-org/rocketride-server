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
| `llm_xai`            | xAI (Grok)                                 |                                                           |
| `llm_vertex`         | Google Vertex AI                           |                                                           |
| `llm_ibm_watson`     | IBM Watson                                 |                                                           |
| `llm_vision_mistral` | Mistral Vision (multimodal, image-to-text) | [README](../nodes/src/nodes/llm_vision_mistral/README.md) |

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

## Media

| Node            | Description            |
| --------------- | ---------------------- |
| `frame_grabber` | Video frame extraction |
| `image_cleanup` | Image preprocessing    |
| `thumbnail`     | Thumbnail generation   |
| `audio_player`  | Audio playback         |

## Storage and Connectivity

| Node           | Description               |
| -------------- | ------------------------- |
| `remote`       | S3, Azure Blob, GCS       |
| `db_mysql`     | MySQL database            |
| `index_search` | Elasticsearch, OpenSearch |

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

## Internal

| Node       | Description                                                           |
| ---------- | --------------------------------------------------------------------- |
| `llm_base` | Compatibility wrapper; canonical base is `ai.common.llm_base.LLMBase` |
| `library`  | Shared library utilities                                              |
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

3. Add `services.json` for the node definition.
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

## Local Nodes for Prototyping

To try out a new node without adding it to this repo, create a folder called `nodes/` at the root of your VS Code / Cursor workspace and drop the node in there. The extension picks it up automatically and exposes it to the engine.

### Quick start

Lay out your workspace like this:

```text
my-workspace/
├── my-pipeline.pipe
└── nodes/
    └── hello_world/
        ├── services.json
        ├── __init__.py
        ├── hello_world.py
        ├── hello_world.svg     # icon — lives with the node, not elsewhere
        └── requirements.txt    # optional
```

Each node is **self-contained**: sources, `services.json`, and the SVG icon all live in the node's own directory.

Open the workspace in VS Code / Cursor, mark it as **trusted** (the standard Workspace Trust prompt), and start the engine. You should see in the engine output channel:

```text
✅ Local nodes registered (1): hello_world
```

Reference the node from your `.pipe` by its protocol just like any built-in. After any change to the node files, run `Ctrl+Shift+P` (`Cmd+Shift+P` on macOS) → **Developer: Reload Window** to pick them up.

### Path convention

Because the symlink lives alongside the built-in nodes in the engine's `nodes/` directory, your `services.json` uses the **same** `"path": "nodes.<your_node>"` convention as built-in nodes. No special prefix, no different import resolution.

### Safety

- **Workspace Trust** is required. In an untrusted workspace the local `nodes/` folder is logged and ignored.
- **Built-ins are never overwritten.** If a local node's directory name collides with an installed engine node, the local one is skipped and a warning is logged.

### Promoting a local node to a built-in

When the node is ready to ship:

1. Move the folder from `<workspace>/nodes/<your_node>/` to this repo's `nodes/src/nodes/<your_node>/`.
2. Commit it. The folder ships as a unit — no changes to `services.json`, no edits anywhere in `packages/`. Self-contained on the way in, self-contained on the way out.

---

## License

MIT License -- see [LICENSE](../LICENSE).
