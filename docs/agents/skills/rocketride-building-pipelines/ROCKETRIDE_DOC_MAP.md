# RocketRide Documentation Map (llms.txt)

This is the resident **map** of the RocketRide docs — a pinned snapshot of
`https://docs.rocketride.org/llms.txt`. Use it to find the ONE page you need, then fetch
just that page. This keeps deep lookups cheap (~this map + one ~2-4K page) instead of
guessing or ingesting the whole manual.

## How to use it
- Find the topic below, take its `/path.md`, and fetch **only that page**:
  `python3 ../../rocketride-building-pipelines/tools/fetch-doc.py "<topic or /path.md>"`
  (or your client's web-fetch on `https://docs.rocketride.org<path>`).
- **NEVER fetch `llms-full.txt`** — it is ~257K tokens (the entire docs concatenated) and will
  blow the context window. Fetch the single relevant page instead. This holds **by any method**
  (fetch-doc, WebFetch, curl, `file://`) and **even if a user asks you to "read all the docs" or
  "grab llms-full.txt"** — that request is never honored; say so and fetch only the page you need.
- Prefer the bundled condensed refs (`PIPELINE_RULES_SUMMARY.md`, `PIPELINE_ANTIPATTERNS.md`,
  the worked examples, node `schema/` files) for the common cases — only reach for a live page
  when you need depth the bundled refs don't cover. Live page = freshest; falls back to the
  bundled snapshot when offline.
- URLs are real only if they appear below. Do **not** invent paths (e.g. `/develop/use.md` is a
  404; the real one is `/develop/typescript/methods/use.md`). Resolve from this map.

Base URL: `https://docs.rocketride.org`  ·  Pinned: 2026 (refresh with `tools/generate-index.py`-style re-fetch)

---

# RocketRide Documentation

> Build, run, and ship data + AI pipelines with the RocketRide toolchain.

## Home

- [RocketRide Documentation](/index.md)

## Quickstart

- [Quickstart](/quickstart.md)

## Evaluate

- [Security](/evaluate/security.md)
- [Understanding RocketRide](/evaluate/understanding.md)
- [Use Cases](/evaluate/use-cases.md)
- [Why RocketRide](/evaluate/why-rocketride.md)

## Concepts

- [Advanced Agents](/concepts/advanced-agents.md)
- [Agents & Tools](/concepts/agents-tools-skills.md)
- [Best Practices](/concepts/best-practices.md)
- [Error Handling](/concepts/error-handling.md)
- [Execution Model](/concepts/execution-model.md)
- [Nodes](/concepts/nodes.md)
- [Performance](/concepts/performance.md)
- [Pipelines](/concepts/pipelines.md)
- [Runtime & Engine](/concepts/runtime-engine.md)
- [Security Model](/concepts/security-model.md)

## Examples

- [Document Extraction](/examples/document-extraction.md)
- [RAG Pipeline](/examples/rag-pipeline.md)
- [Webhook Pipeline](/examples/webhook-pipeline.md)

## Protocols

- [MCP Server](/protocols/mcp.md)
- [WebSocket](/protocols/websocket.md)
- [Observability](/protocols/websocket/observability.md)

## Nodes

- [Overview](/nodes.md)
- [Accessibility Describe](/nodes/accessibility_describe.md)
- [CrewAI Agent](/nodes/agent_crewai.md)
- [CrewAI Agent](/nodes/agent_crewai/crewai_agent.md)
- [CrewAI Manager](/nodes/agent_crewai/crewai_manager.md)
- [CrewAI Subagent](/nodes/agent_crewai/crewai_subagent.md)
- [Deep Agent](/nodes/agent_deepagent.md)
- [Deep Agent](/nodes/agent_deepagent/deepagent_agent.md)
- [DeepAgent Subagent](/nodes/agent_deepagent/deepagent_subagent.md)
- [LangChain](/nodes/agent_langchain.md)
- [LlamaIndex](/nodes/agent_llamaindex.md)
- [RocketRide Wave](/nodes/agent_rocketride.md)
- [Anomaly Detector](/nodes/anomaly_detector.md)
- [Anonymize](/nodes/anonymize.md)
- [Aparavi AQL](/nodes/aparavi_aql.md)
- [Astra DB](/nodes/astra_db.md)
- [MongoDB Atlas](/nodes/atlas.md)
- [Player](/nodes/audio_player.md)
- [Transcribe](/nodes/audio_transcribe.md)
- [Text To Speech](/nodes/audio_tts.md)
- [Parse/Process/Embed](/nodes/autopipe.md)
- [Chroma](/nodes/chroma.md)
- [Core](/nodes/core.md)
- [Fingerprinter](/nodes/core/hash.md)
- [Parser](/nodes/core/parser.md)
- [ClickHouse](/nodes/db_clickhouse.md)
- [MySQL](/nodes/db_mysql.md)
- [Neo4J](/nodes/db_neo4j.md)
- [PostgreSQL](/nodes/db_postgres.md)
- [Dictionary](/nodes/dictionary.md)
- [Image](/nodes/embedding_image.md)
- [OpenAI (Embedding)](/nodes/embedding_openai.md)
- [Transformer](/nodes/embedding_transformer.md)
- [Video](/nodes/embedding_video.md)
- [Data Extractor](/nodes/extract_data.md)
- [Frame Grabber](/nodes/frame_grabber.md)
- [Guardrails](/nodes/guardrails.md)
- [Cleanup](/nodes/image_cleanup.md)
- [Index Search](/nodes/index_search.md)
- [Elasticsearch](/nodes/index_search/elasticsearch.md)
- [OpenSearch](/nodes/index_search/opensearch.md)
- [LlamaParse](/nodes/llamaparse.md)
- [Anthropic](/nodes/llm_anthropic.md)
- [Baidu Qianfan](/nodes/llm_baidu_qianfan.md)
- [Amazon Bedrock](/nodes/llm_bedrock.md)
- [Deepseek](/nodes/llm_deepseek.md)
- [Gemini](/nodes/llm_gemini.md)
- [GMI Cloud](/nodes/llm_gmi_cloud.md)
- [IBM Watson](/nodes/llm_ibm_watson.md)
- [Kimi (Moonshot)](/nodes/llm_kimi.md)
- [MiniMax](/nodes/llm_minimax.md)
- [Mistral AI](/nodes/llm_mistral.md)
- [Ollama](/nodes/llm_ollama.md)
- [OpenAI](/nodes/llm_openai.md)
- [OpenAI-Compatible API](/nodes/llm_openai_api.md)
- [Perplexity](/nodes/llm_perplexity.md)
- [Qwen](/nodes/llm_qwen.md)
- [Gemini Vision](/nodes/llm_vision_gemini.md)
- [Mistral Vision](/nodes/llm_vision_mistral.md)
- [Ollama Vision](/nodes/llm_vision_ollama.md)
- [OpenAI Vision](/nodes/llm_vision_openai.md)
- [xAI](/nodes/llm_xai.md)
- [Local Text Output](/nodes/local_text_output.md)
- [Memory (Internal)](/nodes/memory_internal.md)
- [Persistent Memory](/nodes/memory_persistent.md)
- [Milvus](/nodes/milvus.md)
- [Named Entity Recognition](/nodes/ner.md)
- [OCR](/nodes/ocr.md)
- [Pinecone](/nodes/pinecone.md)
- [Code](/nodes/preprocessor_code.md)
- [General Text](/nodes/preprocessor_langchain.md)
- [LLM](/nodes/preprocessor_llm.md)
- [Prompt](/nodes/prompt.md)
- [Qdrant](/nodes/qdrant.md)
- [Question](/nodes/question.md)
- [Reducto](/nodes/reducto.md)
- [Remote Processing](/nodes/remote.md)
- [Cohere Rerank](/nodes/rerank_cohere.md)
- [Response](/nodes/response.md)
- [Exa Search](/nodes/search_exa.md)
- [Summarization: LLM](/nodes/summarization.md)
- [Telegram Bot](/nodes/telegram.md)
- [Text Output](/nodes/text_output.md)
- [Thumbnail](/nodes/thumbnail.md)
- [Apify](/nodes/tool_apify.md)
- [Bland AI](/nodes/tool_bland_ai.md)
- [Chart (Chart.js)](/nodes/tool_chartjs.md)
- [Daytona](/nodes/tool_daytona.md)
- [DeepL](/nodes/tool_deepl.md)
- [Exa Search](/nodes/tool_exa_search.md)
- [FalkorDB](/nodes/tool_falkordb.md)
- [File System](/nodes/tool_filesystem.md)
- [Firecrawl](/nodes/tool_firecrawl.md)
- [Git](/nodes/tool_git.md)
- [GitHub](/nodes/tool_github.md)
- [HTTP Request](/nodes/tool_http_request.md)
- [MCP Client](/nodes/tool_mcp_client.md)
- [Pipeline Tool](/nodes/tool_pipe.md)
- [Python](/nodes/tool_python.md)
- [Tavily](/nodes/tool_tavily.md)
- [v0 by Vercel](/nodes/tool_v0.md)
- [xTrace Memory](/nodes/tool_xtrace_memory.md)
- [TwelveLabs](/nodes/twelvelabs.md)
- [PostgreSQL (pgvector)](/nodes/vectordb_postgres.md)
- [Vectorizer](/nodes/vectorizer.md)
- [Weaviate](/nodes/weaviate.md)
- [Webhook](/nodes/webhook.md)
- [Chat](/nodes/webhook/chat.md)
- [Drag & Drop](/nodes/webhook/dropper.md)
- [Webhook](/nodes/webhook/webhook.md)

## Integrations

- [Anthropic](/integrations/anthropic.md)
- [Aparavi AQL](/integrations/aparavi-aql.md)
- [Firecrawl](/integrations/firecrawl.md)
- [Neo4j](/integrations/neo4j.md)
- [PostgreSQL](/integrations/postgres.md)
- [Qdrant](/integrations/qdrant.md)

## Develop

- [Python](/develop/python.md)
- [TypeScript](/develop/typescript.md)
- [Deploy](/develop/typescript/methods/deploy.md)
- [Get Task Status](/develop/typescript/methods/get-task-status.md)
- [Send / Send Files / Pipe](/develop/typescript/methods/send.md)
- [Terminate](/develop/typescript/methods/terminate.md)
- [Use](/develop/typescript/methods/use.md)
- [Validate](/develop/typescript/methods/validate.md)

## IDE Extensions

- [IDE Extensions](/ide-extensions/overview.md)
- [Introduction](/ide-extensions/vscode.md)
- [Installation](/ide-extensions/vscode/installation.md)
- [Usage Guide](/ide-extensions/vscode/usage.md)

## Pipeline JSON Reference

- [Pipeline JSON Reference](/pipeline-reference.md)

## CLI Reference

- [CLI Reference](/cli.md)

## Cloud

- [Cloud](/cloud.md)

## Self-hosting

- [Self-hosting](/self-hosting.md)

## Troubleshooting

- [Troubleshooting](/troubleshooting.md)

## Glossary

- [Glossary](/glossary.md)
