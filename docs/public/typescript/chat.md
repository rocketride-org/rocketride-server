---
title: Chat
sidebar_position: 7
---

# Chat

Conversational pipelines: build a `Question`, send it with `client.chat()`, and
parse the response with `Answer`. Class tables in the
[API reference](/clients/typescript/reference#question).

Chat is the conversational lane: it works against `chat`, `webhook`, and
`dropper` pipeline sources. Under the hood the
client opens a pipe with MIME type `application/rocketride-question`, writes the
serialized `Question`, closes the pipe, and returns the server result.

## Build a Question

```typescript
import { Question } from 'rocketride';

const question = new Question({ expectJson: true });
question.addInstruction('Format', 'Return a JSON object with keys: summary, keywords.');
question.addExample('Summarize X', { summary: '...', keywords: ['a', 'b'] });
question.addQuestion('Summarize the main points and list keywords.');
```

`new Question({ type?, filter?, expectJson?, role? })` — `QuestionType` is one of
`QUESTION`, `SEMANTIC`, `KEYWORD`, `GET`, `PROMPT` (default `QUESTION`). Steer the
model with `addInstruction`, `addExample`, `addContext`, `addHistory` (for
multi-turn), `addDocuments`, `addGoal`, and `addQuestion`.

## Send it

```typescript
const response = await client.chat({ token, question });
```

`chat({ token, question, onSSE? })` — the optional `onSSE` callback streams
server-sent events (token-by-token output) as they arrive. The final answer is in
the result body.

## Parse the response with Answer

`Answer` extracts structure from AI text, which often arrives wrapped in markdown
or code fences. The client does **not** attach an `Answer` to the result — you read
the body and feed it in:

```typescript
import { Answer } from 'rocketride';

const answerText = response?.answers?.[0];
const answer = new Answer(true); // expectJson
answer.setAnswer(answerText ?? '');
const structured = answer.isJson() ? answer.getJson() : answer.getText();
```

Semantics worth knowing:

- `new Answer(expectJson = false)` — construct with `true` when you asked the model
  for JSON; `setAnswer()` then validates/parses the content as JSON.
- `isJson()` returns the `expectJson` flag the `Answer` was constructed with — it
  does **not** inspect the content.
- `getJson()` returns the parsed JSON and **throws** if the stored answer is not
  JSON-compatible; `getText()` returns plain text.
- `Answer.parsePython(value)` (static) extracts Python code from a code block.

A complete chat program is [example 6](/clients/typescript/examples#6-chat-question-with-instructions-and-examples-parse-json-answer).
