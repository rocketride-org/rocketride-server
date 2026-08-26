---
title: RAG Pipeline
sidebar_position: 1
---

# RAG Pipeline

Retrieval-augmented generation (RAG) is the most common pattern in RocketRide:
embed documents into a vector store, then answer questions by retrieving the
relevant chunks and feeding them to an LLM. This example walks through a
complete pipeline that accepts questions over HTTP, retrieves context from
Qdrant, and returns answers.

## What you need

- An OpenAI API key
- A running [Qdrant](https://qdrant.tech) instance (local Docker or Qdrant Cloud)
- The RocketRide engine running ([self-hosted](/operate/self-hosting) or [Cloud](/operate/cloud))

## The pipeline

Save this as `rag.pipe`:

```json
{
  "project_id": "rag-example",
  "components": [
    {
      "id": "source_1",
      "provider": "webhook"
    },
    {
      "id": "parser_1",
      "provider": "parse",
      "input": [
        { "lane": "tags", "from": "source_1" }
      ]
    },
    {
      "id": "prep_1",
      "provider": "preprocessor_langchain",
      "config": {
        "profile": "default",
        "default": {
          "mode": "strlen",
          "splitter": "RecursiveCharacterTextSplitter",
          "strlen": 512
        }
      },
      "input": [
        { "lane": "text", "from": "parser_1" }
      ]
    },
    {
      "id": "embed_1",
      "provider": "embedding_openai",
      "config": {
        "profile": "text-embedding-3-small",
        "apikey": "${OPENAI_API_KEY}"
      },
      "input": [
        { "lane": "documents", "from": "prep_1" },
        { "lane": "questions", "from": "source_1" }
      ]
    },
    {
      "id": "store_1",
      "provider": "qdrant",
      "config": {
        "profile": "local",
        "local": {
          "host": "localhost",
          "port": 6333,
          "collection": "rag-docs"
        }
      },
      "input": [
        { "lane": "documents", "from": "embed_1" },
        { "lane": "questions", "from": "embed_1" }
      ]
    },
    {
      "id": "llm_1",
      "provider": "llm_openai",
      "config": {
        "profile": "openai-4o",
        "apikey": "${OPENAI_API_KEY}"
      },
      "input": [
        { "lane": "questions", "from": "store_1" }
      ]
    },
    {
      "id": "target_1",
      "provider": "response",
      "input": [
        { "lane": "answers", "from": "llm_1" }
      ]
    }
  ]
}
```

## What each node does

| Node | Provider | Role |
| --- | --- | --- |
| `source_1` | `webhook` | Exposes an HTTP endpoint. Incoming documents arrive on the `tags` lane; incoming questions arrive on the `questions` lane. |
| `parser_1` | `parse` | Converts each uploaded file (PDF, Word, etc.) into clean text on the `text` lane. |
| `prep_1` | `preprocessor_langchain` | Splits the text into chunks and emits them on the `documents` lane. |
| `embed_1` | `embedding_openai` | Turns document chunks into vectors using `text-embedding-3-small` and emits `documents` (vectors + metadata). Also embeds incoming questions before retrieval. |
| `store_1` | `qdrant` | Upserts vectors from `embed_1` into the `rag-docs` collection. When an embedded question arrives, it retrieves the top matching chunks and re-emits them as `questions` with context injected. |
| `llm_1` | `llm_openai` | Receives the question + retrieved context and generates an answer using GPT-4o. |
| `target_1` | `response` | Returns the answer to the caller. |

## Start the pipeline

```bash
rocketride start --pipeline ./rag.pipe
```

The engine prints the webhook URL and public auth key:

```text
Webhook ready - system is ready to accept requests
  URL:  http://localhost:5567/webhook/rag-example/source_1
  Auth: abc123...
```

## Ingest documents

POST a document to the webhook URL. The pipeline embeds and stores it:

```bash
curl -X POST http://localhost:5567/webhook/rag-example/source_1 \
  -H "Authorization: Bearer abc123..." \
  -F "file=@./my-document.pdf"
```

## Ask a question

Send a plain-text question to the same endpoint:

```bash
curl -X POST http://localhost:5567/webhook/rag-example/source_1 \
  -H "Authorization: Bearer abc123..." \
  -H "Content-Type: text/plain" \
  -d "What does the document say about refund policy?"
```

The pipeline retrieves the relevant chunks from Qdrant, asks GPT-4o, and streams
back the answer.

## Next steps

- Swap `embedding_openai` for [`embedding_transformer`](/nodes/embedding_transformer) to run embeddings locally without an API key.
- Swap `qdrant` for [`pinecone`](/nodes/store_pinecone) or [`milvus`](/nodes/store_milvus) without changing the rest of the pipeline.
- Add a [`guardrails`](/nodes/guardrails) node between the LLM and response to validate outputs.
- See the [`store_qdrant` node reference](/nodes/store_qdrant) for configuration details.
