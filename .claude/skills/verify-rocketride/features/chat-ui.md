# Chat page

The engine serves the chat page (`apps/chat-ui`) at `/chat`. Opened with `?auth=<public key>` of a running chat pipeline, it connects to that pipeline, sends each question with the recent conversation as history, and shows the pipeline's answers. VS Code's chat panel shows the same page.

## Sub-features

- `chatui-answer` shows the question and then the pipeline's answer in the conversation.
- `chatui-no-answer` shows `I don't see any answers in there...` when the pipeline has no Return Answers node.

## How to get to it (user POV)

- Run a pipeline with a Chat source in VS Code and type in the chat panel. [vscode-canvas.md](./vscode-canvas.md) drives that path with `rr-verify vscode chat`.
- Open `http://127.0.0.1:<port>/chat?auth=<public key>` in a browser. The public key is the `publicToken` that `client.use()` returns for the task, and it starts with `pk_`. The endpoint dialog in VS Code shows the same URL.

## Driving it with rr-verify

Preconditions:

- Your run was launched with `--mock` and `rr-verify doctor` exits 0, with no `WARN` line for `chat-ui`.
- `rr-verify tscli -- list` prints `No active tasks found`.

- **Ask a question.** Run `rr-verify browse --label chatui-answer $F/browser/chat-ui.mjs`. It starts `$F/quickstart-chat.pipe` through the TypeScript SDK, opens `/chat?auth=pk_...`, waits for `Connected`, sends `What is RocketRide?`, waits for `Mock LLM response`, checks that the question is still in the conversation, and terminates the task. The output ends with `PASS: 12 step(s) passed`, and `<time>-answer.png` shows the exchange.
- **Drop Return Answers.** Run `rr-verify browse --label chatui-no-answer $F/browser/chat-ui.mjs $F/quickstart-chat-no-return.pipe "What is RocketRide?" "I don't see any answers in there"`. The output ends with `PASS: 12 step(s) passed`.
- **Ask your own question.** The script takes the pipeline file, the question, and text the answer must contain: `rr-verify browse --label <feature-id> $F/browser/chat-ui.mjs <file.pipe> "<question>" "<expected text>"`. Pick expected text that is not in the question, because the question is on the page too.
- **Confirm cleanup.** Run `rr-verify tscli --label chatui-cleanup -- list`. It prints `No active tasks found`.

## Gotchas

- A wrong or stale public key, such as one from a task that has stopped, leaves the page on `Connecting...` with no error message. The only sign is the console error `Failed to start client: AuthenticationException: Bad request`, which `rr-verify browse` lists. This is pre-existing (confirmed 2026-10-27).
- The page keeps the key in `sessionStorage` and removes `?auth=` from the address bar after it connects, so the final URL in a screenshot has no key.
- Every browse run starts a fresh browser, so nothing carries over between runs. To check history, ask two questions in one script.
- Mock replies prove the wiring, not answer quality. Say "mocked LLM" next to any result from a `--mock` run.
