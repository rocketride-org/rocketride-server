# Chat pipeline

A chat pipeline takes a question from a Chat source, sends it to an LLM node, and returns the LLM's answer to the caller through a Return Answers node. This is the pipeline the IDE quickstart builds. Without Return Answers, the pipeline still runs but returns no answer.

## Sub-features

- `chat-answer` returns at least one answer for a question.
- `chat-no-return` returns no `answers` field when the pipeline has no Return Answers node.
- `chat-real-llm` returns a real model answer. It needs a provider key and a run without `--mock`.

## How to get to it (user POV)

- Build Chat, then an LLM node, then Return Answers on the VS Code canvas, press Run on the Chat node, and type in the chat panel. This skill cannot drive VS Code yet.
- Open the engine's chat page at `/chat?auth=<pipeline public key>` in a browser. This skill cannot drive browsers yet.
- Call `client.use(filepath=...)` and then `client.chat(token=..., question=...)` from the Python SDK.

## Driving it with rr-verify

Preconditions:

- A run launched with `rr-verify launch --mock` is live and passes `rr-verify doctor`.
- No task from the same pipeline is running. `rr-verify tscli -- list` prints `No active tasks found`.

- **Ask a question.** Run `rr-verify chat "What is RocketRide?"`. The result has an `answers` list with one string, and the output ends with `PASS: 1 answer(s) returned` and exit code 0. Under `--mock`, the answer is `Mock LLM response. This stub is used when ROCKETRIDE_MOCK is set so tests run without API keys or external services.`
- **Drop Return Answers.** Run `rr-verify chat --pipe $F/quickstart-chat-no-return.pipe --expect none "What is RocketRide?"`. The result has no `answers` field, and the output ends with `PASS: no answers returned, as expected`.
- **Catch a missing Return Answers.** Run `rr-verify chat --pipe $F/quickstart-chat-no-return.pipe "What is RocketRide?"`. The output ends with `FAIL: expected answers, got none` and exit code 1. Use this to confirm the check can fail.
- **Check your own pipeline.** Run `rr-verify chat --pipe <path to .pipe> "<question>"`. Read the saved JSON's `result` for the lanes your change affects.
- **Confirm cleanup.** Run `rr-verify tscli -- list`. It prints `No active tasks found`, because `rr-verify chat` terminates its task.
- **Proof.** Each run saves `.verify/<run-id>/chat-pipeline/<time>-chat.json` with the pipeline, the question, the result, and the verdict.

## Gotchas

- The chat UI shows `I don't see any answers in there...` when a result has no answers. The SDK check above proves the missing `answers` field, not the UI message.
- `${ROCKETRIDE_OPENAI_KEY}` in a `.pipe` file is filled from the engine's environment. `rr-verify launch --mock` sets a placeholder. Without `--mock`, export a real key before launching.
- Two pipelines with the same `project_id` cannot run at once. A second start fails with `Pipeline is already running.` Stop the first task, or give the copy a different `project_id`.
- Use `client.chat` for chat-source pipelines. `client.send` is for webhook and dropper sources.
