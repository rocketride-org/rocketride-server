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
  "source": "source_1",
  "components": [
    {
      "id": "source_1",
      "provider": "webhook",
      "config": {}
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
      "provider": "response_answers",
      "config": {},
      "input": [
        { "lane": "answers", "from": "llm_1" }
      ]
    }
  ]
}
```

Three nodes, one connection each. The `webhook` source receives the request, the
`llm_openai` node answers it, and the `response_answers` target returns the result.

## Start the pipeline

```bash
export ROCKETRIDE_OPENAI_API_KEY=sk-...

rocketride start --pipeline ./chat.pipe
```

Output:

```text
Starting pipeline from ./chat.pipe...
Pipeline started.
Token: <task-token>
Stop it with: rocketride stop --token <task-token>
```

`start` exits after it prints the token. The pipeline keeps running on the
engine until you stop it with that command. The token is not an address.

## Send a question

A running webhook pipeline is reached on the engine's own port, at
`/webhook/<project_id>/<source>`. Both parts come from the pipeline file: here
`project_id` is `webhook-example` and `source` is `source_1`. The request must
carry the engine's API key (the `ROCKETRIDE_APIKEY` you set for the CLI) as a
bearer token. A request without it is refused with 401.

The LLM in this pipeline listens on the `questions` lane, so send the question
as `application/rocketride-question` with this JSON body. Plain text goes to the
`text` lane and gets no answer from this pipeline.

curl reads the key from your shell, not from `.env`, so set it first:

```bash
export ROCKETRIDE_APIKEY=<the key your engine was started with>
curl -X POST "http://localhost:5565/webhook/webhook-example/source_1" \
  -H "Authorization: Bearer $ROCKETRIDE_APIKEY" \
  -H "Content-Type: application/rocketride-question" \
  -d '{"type":"question","questions":[{"text":"What is the capital of France?"}]}'
```

The reply is a JSON envelope. The `response_answers` node puts each answer in an
`answers` array under the object it was sent as (`body`). Shape, with other
fields left out:

```json
{
  "status": "OK",
  "data": {
    "objects": {
      "body": {
        "answers": ["The capital of France is Paris."],
        "status": "OK"
      }
    }
  }
}
```

## Use the Chat UI variant

Swap `webhook` for `chat` to get a browser-based chat window instead of a raw
HTTP endpoint, no `curl` required:

```json
{ "id": "source_1", "provider": "chat" }
```

Restart the pipeline. The chat page is on the engine port, at
`http://localhost:5565/chat/webhook-example/source_1?auth=<task token>`. Use the
task token that `rocketride start` prints. `start` does not print the address
itself.

Open that URL in a browser and start typing. The `?auth=` query parameter is a
convenience for supplying the credential to the browser; the Chat UI stores it
in session storage for subsequent page loads. The page opens with any
credential, but sending a question needs the task token. Your engine key
(`ROCKETRIDE_APIKEY`) opens the page, then fails with "Your pipeline is not
running". Webhook requests use the engine key in an
`Authorization: Bearer <ROCKETRIDE_APIKEY>` header.

The URL includes the project and source identifiers, so it is
specific to this pipeline. The legacy `/webhook`, `/task/data`, `/chat`, and
`/dropper` URLs continue to work for existing integrations.

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
