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
# The key the CLI sends. Replace rr_local with the key your engine requires (its
# RR_APIKEY). A local engine started without a key accepts any non-empty value.
export ROCKETRIDE_APIKEY=rr_local
export ROCKETRIDE_OPENAI_API_KEY=sk-...

rocketride start --pipeline ./chat.pipe
```

Output:

```text
Starting pipeline from ./chat.pipe...
Pipeline started.
Token: =control/1234abcd...
Stop it with: rocketride stop --token =control/1234abcd...
```

`start` exits after it prints the token. The pipeline keeps running on the
engine until you stop it with that command. The token names this run for `stop`
and `upload`; it is not the pipeline's address and is never sent as a key.

## Send a question

A running webhook pipeline is reached on the engine's own port, at
`/webhook/<address>`. The address is `developerId.pipelineId.source` in one path
segment: the pipeline's `project_id` (`webhook-example`) and its source
(`source_1`), under your developer id. On a local engine the developer id is
`rocketride`, so this pipeline is `rocketride.webhook-example.source_1`; on
RocketRide Cloud it is your organization's. The request must carry an API key
as a bearer token, in the header only (a URL never carries a credential): on a
local engine, the key the engine requires, which is the `ROCKETRIDE_APIKEY` you
set for the CLI. A request without one is refused with 401. See
[Endpoint authentication](/operate/security#endpoint-authentication).

The LLM in this pipeline listens on the `questions` lane, so send the question
as `application/rocketride-question` with this JSON body. Plain text is not treated
as a question, so it gets no answer from this pipeline.

curl reads the key from your shell, not from `.env`. It is the `ROCKETRIDE_APIKEY`
you exported before `start`:

```bash
curl -X POST "http://localhost:5565/webhook/rocketride.webhook-example.source_1" \
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

Restart the pipeline. `start` does not print an address. The chat page is the
platform app `rocketride.chat`: press **Open Chat** on the chat node in the
Builder and it opens beside the canvas, bound to this pipeline's address. From
a browser, open the signed-in deep link on the engine's own address:

```text
http://localhost:5565/?appid=rocketride.chat&pipe=rocketride.webhook-example.source_1
```

Once the pipeline is published, anyone you share it with reaches the same chat
by signing in and opening
`?appid=rocketride.chat&pipe=<developerId>.webhook-example.source_1`.
No credential rides a URL, so the link is safe to pass on; webhook requests use
an `rr_` key in an `Authorization: Bearer` header.

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
