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
- The RocketRide engine running ([self-hosted](/self-hosting) or [Cloud](/cloud))

## The pipeline

Save this as `rag.pipe`:

```json
{
  "nodes": [
    {
      "id": "source_1",
      "provider": "webhook"
    },
    {
      "id": "embed_1",
      "provider": "embedding_openai",
      "config": {
        "profile": "text-embedding-3-small",
        "apikey": "${OPENAI_API_KEY}"
      },
      "input": [
        { "lane": "text", "from": "source_1" }
      ]
    },
    {
      "id": "store_1",
      "provider": "qdrant",
      "config": {
        "profile": "self-hosted",
        "serverName": "localhost",
        "collection": "rag-docs"
      },
      "input": [
        { "lane": "documents", "from": "embed_1" },
        { "lane": "questions", "from": "source_1" }
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
| `source_1` | `webhook` | Exposes an HTTP endpoint. Incoming documents arrive on the `text` lane; incoming questions arrive on the `questions` lane. |
| `embed_1` | `embedding_openai` | Turns document text into vectors using `text-embedding-3-small`. Emits `documents` (vectors + metadata). |
| `store_1` | `qdrant` | Upserts vectors from `embed_1` into the `rag-docs` collection. When a question arrives, it retrieves the top matching chunks and re-emits them as `questions` with context injected. |
| `llm_1` | `llm_openai` | Receives the question + retrieved context and generates an answer using GPT-4o. |
| `target_1` | `response` | Returns the answer to the caller. |

## Start the pipeline

```bash
rocketride start --pipeline ./rag.pipe
```

The engine prints the webhook URL and public auth key:

```text
Webhook ready - system is ready to accept requests
  URL:  http://localhost:5567/task/data
  Auth: abc123...
```

## Ingest documents

POST a document to the webhook URL. The pipeline embeds and stores it:

```bash
curl -X POST http://localhost:5567/task/data \
  -H "Authorization: Bearer abc123..." \
  -F "file=@./my-document.pdf"
```

## Ask a question

Send a plain-text question to the same endpoint:

```bash
curl -X POST http://localhost:5567/task/data \
  -H "Authorization: Bearer abc123..." \
  -H "Content-Type: text/plain" \
  -d "What does the document say about refund policy?"
```

The pipeline retrieves the relevant chunks from Qdrant, asks GPT-4o, and streams
back the answer.

## Next steps

- Swap `embedding_openai` for [`embedding_transformer`](/nodes/embedding_transformer) to run embeddings locally without an API key.
- Swap `qdrant` for [`pinecone`](/nodes/pinecone) or [`milvus`](/nodes/milvus) without changing the rest of the pipeline.
- Add a [`guardrails`](/nodes/guardrails) node between the LLM and response to validate outputs.
- See the [Qdrant integration guide](/integrations/qdrant) for configuration details.
