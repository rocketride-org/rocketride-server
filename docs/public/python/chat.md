---
title: Chat
sidebar_position: 7
---

# Chat

Conversational pipelines: build a `Question`, send it with `client.chat()`, and
parse the response with `Answer`. Class tables in the
[API reference](/clients/python/reference#question).

Chat is the conversational lane: it works against `chat`, `webhook`, and
`dropper` pipeline sources. Under the hood the
client opens a pipe with MIME type `application/rocketride-question`, writes the
serialized `Question`,
closes the pipe, and returns the server result.

## Build a Question

```python
from rocketride.schema import Question

question = Question(expectJson=True)
question.addInstruction('Format', 'Return a JSON object with keys: summary, keywords.')
question.addExample('Summarize X', {'summary': '...', 'keywords': ['a', 'b']})
question.addQuestion('Summarize the main points and list keywords.')
```

If you send the same question again and again with only its context, documents,
goals or questions changing (an agent loop does), set `question.cachePrefix = True`.
A provider that supports prompt caching (the Anthropic node, and Claude models on
the Bedrock node) may then cache the unchanging start of the prompt; other
providers ignore the flag.

`Question(type=QuestionType.QUESTION, filter=DocFilter(), expectJson=False, cachePrefix=False, role='')` —
`QuestionType` is one of `QUESTION`, `SEMANTIC`, `KEYWORD`, `GET`, `PROMPT`. Steer
the model with `addInstruction`, `addExample`, `addContext`, `addHistory` (for
multi-turn), `addDocuments`, `addGoal`, and `addQuestion`.

## Send it

```python
response = await client.chat(token=token, question=question)
```

`chat(*, token, question, on_sse=None)` is keyword-only; the optional `on_sse`
callback streams server-sent events (token-by-token output) as they arrive. The
final answer is in the result body.

## Parse the response with Answer

`Answer` extracts structure from AI text, which often arrives wrapped in markdown or
code fences. The client does **not** attach an `Answer` to the result — you read the
body and feed it in:

```python
from rocketride.schema import Answer

answer_text = (response.get('answers') or [None])[0]
answer = Answer(expectJson=True)
answer.setAnswer(answer_text or '')
if answer.isJson():
    structured = answer.getJson()
else:
    structured = answer.getText()
```

Semantics worth knowing:

- `setAnswer(value)` stores the response, validating/parsing it as JSON when
  `expectJson` is `True`.
- `isJson()` returns the `expectJson` flag — it does **not** inspect the content.
- `getJson()` returns the parsed JSON; it returns `None` only when no answer has
  been set, and **raises `ValueError`** if the stored answer is not valid JSON.
- `getText()` returns the answer as plain text; `parsePython(value)` extracts Python
  code from a code block.
- `answer.tokens` carries the turn-total LLM token usage reported by the server.

A complete chat program is [example 6](/clients/python/examples#6-chat-question-with-instructions-and-examples-parse-json-answer).

## Native tool calling

Put the conversation in `messages` to send it as real model turns, with tools
the model can call. A non-empty `messages` is turn mode. The model answers with
a message you append unchanged, a stop reason, and any tool calls. You run the
tools and send each result back under the call's `id`.

```python
from rocketride.schema import Answer, Question, Tool, UserMessage

question = Question(
    role='You file GitHub issues.',
    tools=[Tool(name='github.create_issue', description='Create an issue.', inputSchema=schema)],
    messages=[UserMessage(content='File an issue about the flaky test.')],
)
while True:
    answer = Answer.fromResult(await client.chat(token=token, question=question))
    if answer.error:
        raise RuntimeError(answer.error.message)
    question.addMessage(answer.message)
    if answer.stopReason != 'tool_use':
        break
    for call in answer.toolCalls():
        question.addToolResult(call.id, run_tool(call.name, call.args))
print(answer.getText())
```

- Tool names stay yours, dots included. The engine maps them to names the
  provider accepts and maps calls back.
- `call.args` is a dict, or the raw string when the model's arguments were not
  valid JSON. Answer a string with `addToolResult(call.id, '...', isError=True)`.
- The system prompt is `role`, instructions and examples. Context, documents and
  goals are added to the last user message, so a RAG node upstream still works.
  `history`, `questions` and `expectJson` are rejected in turn mode.
- Reasoning blocks in `answer.message` carry provider state. Keep them as they
  are; the next request needs them.
- With `cachePrefix=True`, the Anthropic node caches the system prompt and the
  conversation so far.
- The Anthropic, OpenAI and OpenAI-Compatible API nodes support turn mode. Any
  other LLM node answers with `answer.error.code == 'tools_unsupported'` before calling
  its model.
- An engine older than turn mode ignores `messages` and answers a near-empty
  prompt as text, so `fromResult` returns a text `Answer` with no `message`.
