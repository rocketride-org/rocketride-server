---
title: Webhook Pipeline
sidebar_position: 2
---

# Webhook Pipeline

The simplest useful pipeline: an HTTP endpoint that accepts a question, sends
it to an LLM, and returns the answer. This is the "hello world" of RocketRide —
a good starting point before adding vector stores, preprocessing, or agents.

## The pipeline

Save this as `chat.pipe`:

```json
{
  "project_id": "webhook-example",
  "components": [
    {
      "id": "source_1",
      "provider": "webhook"
    },
    {
      "id": "llm_1",
      "provider": "llm_openai",
      "config": {
        "profile": "openai-4o-mini",
        "apikey": "${ROCKETRIDE_OPENAI_API_KEY}"
      },
      "input": [
        { "lane": "questions", "from": "source_1" }
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

Three nodes, one connection each. The `webhook` source receives the request, the
`llm_openai` node answers it, and the `response` target returns the result.

## Start the pipeline

```bash
export OPENAI_API_KEY=sk-...

rocketride start --pipeline ./chat.pipe
```

Output:

```text
Webhook ready - system is ready to accept requests
  URL:  http://localhost:5567/webhook/webhook-example/source_1
  Auth: <public-auth-key>
  Token: <private-token>
```

Keep the terminal open — the pipeline runs until you stop it.

## Send a question

```bash
curl -X POST "http://localhost:5567/webhook/webhook-example/source_1" \
  -H "Authorization: Bearer <public-auth-key>" \
  -H "Content-Type: text/plain" \
  -d "What is the capital of France?"
```

Response:

```json
{ "answer": "The capital of France is Paris." }
```

## Use the Chat UI variant

Swap `webhook` for `chat` to get a browser-based chat window instead of a raw
HTTP endpoint, no `curl` required:

```json
{ "id": "source_1", "provider": "chat" }
```

Restart the pipeline. The engine reports the source ready:

```text
Chat ready - system is ready to accept questions
```

Press **Open Chat** on the chat node in the Builder: the chat app opens
beside the canvas, bound to this pipeline's address. Once the pipeline is
published, anyone you share it with reaches the same chat by signing in and
opening `?appid=rocketride.chat&pipe=<developerId>.webhook-example.source_1`.
No credential rides a URL; webhook requests use an `rr_` key in an
`Authorization: Bearer` header.

## Add a system prompt

Give the LLM a persona by adding a `prompt` node:

```json
{
  "id": "prompt_1",
  "provider": "prompt",
  "config": {
    "instructions": ["You are a helpful assistant that answers questions concisely."]
  },
  "input": [
    { "lane": "questions", "from": "source_1" }
  ]
}
```

Then wire `llm_1` to receive from `prompt_1` instead of `source_1`.

## Next steps

- Add a [`qdrant`](/nodes/store_qdrant) store between source and LLM to build the full [RAG pipeline](/examples/rag-pipeline).
- Replace `llm_openai` with [`llm_anthropic`](/nodes/llm_anthropic) or [`llm_ollama`](/nodes/llm_ollama) — the rest of the pipeline is unchanged.
- See the [`llm_anthropic` node reference](/nodes/llm_anthropic) for model profile options.
