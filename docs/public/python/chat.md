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

`Question(type=QuestionType.QUESTION, filter=DocFilter(), expectJson=False, role='')` —
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
