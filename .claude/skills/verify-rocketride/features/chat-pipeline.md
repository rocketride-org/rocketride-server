# Chat pipeline

A chat pipeline takes a question from a Chat source, sends it to an LLM node, and returns the LLM's answer to the caller through a Return Answers node. This is the pipeline the IDE quickstart builds. Without Return Answers, the pipeline still runs but returns no answer.

## Sub-features

- `chat-answer` returns at least one answer for a question.
- `chat-no-return` returns no `answers` field when the pipeline has no Return Answers node.
- `chat-real-llm` returns a real model answer. It needs a provider key and a run without `--mock`.

## How to get to it (user POV)

- Build Chat, then an LLM node, then Return Answers on the VS Code canvas, press Run on the Chat node, and type in the chat panel. This skill cannot drive VS Code yet.
- Open the engine's chat page at `/chat?auth=<pipeline public key>` in a browser. [The chat page feature](./chat-ui.md) drives it.
- Call `client.use(filepath=...)` and then `client.chat(token=..., question=...)` from the Python SDK.

## Driving it with rr-verify

Preconditions:

- Your run was launched with `--mock` and `rr-verify doctor` exits 0.
- `rr-verify tscli -- list` prints `No active tasks found`.

- **Ask a question.** Run `rr-verify chat --label chat-answer "What is RocketRide?"`. The result has an `answers` list with one string, the token line ends `terminated: True  mock: True`, and the output ends with `PASS: 1 answer(s) returned` and exit code 0. Under `--mock` the answer is `Mock LLM response. This stub is used when ROCKETRIDE_MOCK is set so tests run without API keys or external services.`
- **Drop Return Answers.** Run `rr-verify chat --label chat-no-return --pipe $F/quickstart-chat-no-return.pipe --expect none "What is RocketRide?"`. The result has no `answers` field, and the output ends with `PASS: no answers returned, as expected`.
- **Confirm the check can fail.** Run `rr-verify chat --label chat-no-return-control --pipe $F/quickstart-chat-no-return.pipe "What is RocketRide?"`. The output ends with `FAIL: expected answers, got none` and exit code 1. This is the expected result.
- **Ask a real model.** Only when `ROCKETRIDE_OPENAI_KEY` holds a real OpenAI key in your shell. Launch a second run without `--mock`: `. .claude/skills/verify-rocketride/bin/env.sh <run-id>-real && rr-verify launch`. Then, on that run, `rr-verify chat --label chat-real-llm "Reply with the single word pineapple."`. The output ends with `PASS: 1 answer(s) returned`, the token line ends `mock: False`, and the answer is not the mock text and contains `pineapple`. Stop that run when done. Without a key, report `chat-real-llm` as SKIPPED with the reason "no provider key".
- **Check your own pipeline.** Run `rr-verify chat --label <feature-id> --pipe <path to .pipe> "<question>"`. Read the saved JSON's `result` for the lanes your change affects.
- **Confirm cleanup.** Run `rr-verify tscli --label chat-cleanup -- list`. It prints `No active tasks found`.

## Gotchas

- The chat page shows `I don't see any answers in there...` when a result has no answers. The SDK check above proves the missing `answers` field; `chatui-no-answer` in [the chat page feature](./chat-ui.md) proves the message.
- `${ROCKETRIDE_OPENAI_KEY}` in a `.pipe` file is filled from the engine's environment when the pipeline starts. `rr-verify launch --mock` sets a placeholder. Without `--mock`, export the real key before launching.
- Two pipelines with the same `project_id` cannot run at once. A second start fails with `Pipeline is already running.` Stop the first task, or give the copy a different `project_id`.
- Use `client.chat` for chat-source pipelines. `client.send` is for webhook and dropper sources.
- The engine returns an LLM failure, such as a rejected API key, as an answer that starts with `**LLM error** —`. `rr-verify chat` reports that as `FAIL: the answer is an LLM error: ...`, not as an answer. Read the message: it should tell the user what to fix.
