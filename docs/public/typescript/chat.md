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

If you send the same question again and again with only its context, documents,
goals or questions changing (an agent loop does), set `question.cachePrefix = true`.
A provider that supports prompt caching (the Anthropic node, and Claude models on
the Bedrock node) may then cache the unchanging start of the prompt; other
providers ignore the flag.

`new Question({ type?, filter?, expectJson?, cachePrefix?, role? })` — `QuestionType` is one of
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

## Native tool calling

Put the conversation in `messages` to send it as real model turns, with tools
the model can call. A non-empty `messages` is turn mode. The model answers with
a message you append unchanged, a stop reason, and any tool calls. You run the
tools and send each result back under the call's `id`.

```typescript
import { Answer, Question } from 'rocketride';

const question = new Question({ role: 'You file GitHub issues.' });
question.tools = [{ name: 'github.create_issue', description: 'Create an issue.', inputSchema: schema }];
question.addMessage({ role: 'user', content: 'File an issue about the flaky test.' });
for (;;) {
	const answer = Answer.fromResult(await client.chat({ token, question }));
	if (answer.error) throw new Error(answer.error.message);
	question.addMessage(answer.message!);
	if (answer.stopReason !== 'tool_use') {
		console.log(answer.getText());
		break;
	}
	for (const call of answer.toolCalls) {
		question.addToolResult(call.id, await runTool(call.name, call.args));
	}
}
```

- Tool names stay yours, dots included. The engine maps them to names the
  provider accepts and maps calls back.
- `call.args` is an object, or the raw string when the model's arguments were
  not valid JSON. Answer a string with `addToolResult(call.id, '...', true)`.
- The system prompt is `role`, instructions and examples. Context, documents and
  goals are added to the last user message, so a RAG node upstream still works.
  `history`, `questions` and `expectJson` are rejected in turn mode.
- Reasoning blocks in `answer.message` carry provider state. Keep them as they
  are; the next request needs them.
- With `cachePrefix: true`, the Anthropic node caches the system prompt and the
  conversation so far.
- The Anthropic, OpenAI and OpenAI-Compatible API nodes support turn mode. Any
  other LLM node answers with `answer.error.code === 'tools_unsupported'` before
  calling its model.
- `toDict()` sends `messages` and `tools` only when set, so other questions go
  out exactly as before. An engine older than turn mode ignores `messages` and
  answers a near-empty prompt as text, so `fromResult` returns a text `Answer`
  with no `message`.
