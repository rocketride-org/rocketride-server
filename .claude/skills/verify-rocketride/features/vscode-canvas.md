# Pipeline canvas in VS Code

Opening a `.pipe` file in VS Code shows it in the **Pipeline Grid Editor**, a canvas with Design, Development, and Deploy tabs. A source node such as Chat has a Run button. Once the pipeline runs, the Chat node offers **Chat now**, which opens the engine's chat page in an editor tab, and the Run button turns into Stop. This is the flow the IDE quickstart walks through with Chat, an LLM node, and Return Answers. The canvas component is shared with Pipeline Builder in the browser shell; see [shell.md](./shell.md).

## Sub-features

- `canvas-open` opens a `.pipe` file from the RocketRide view's Pipelines tab and shows every node and connection in the file.
- `canvas-run` starts the pipeline from the Run button on its source node; the node reports it is ready and the engine lists the task.
- `canvas-chat` opens the chat panel from **Chat now** and returns an answer to a question.
- `canvas-chat-no-return` shows `I don't see any answers in there...` for a pipeline without Return Answers.
- `canvas-stop` stops the pipeline from the Stop button; the node goes back to idle and the engine lists no task.

## How to get to it (user POV)

- Click a pipeline in the RocketRide view's Pipelines tab, or open a `.pipe` file from the Explorer.
- Press the green Run button on the left of a source node. Press **Chat now** on a running Chat node, type in the chat tab, and press Send.
- Press the red Stop button on the running source node, or **Run** and **Stop** on the Development tab.
- Building a pipeline by hand (adding nodes from the Nodes tab, wiring lanes, editing node settings, saving with Ctrl+S) is a user path this skill does not drive yet.

## Driving it with rr-verify

Preconditions:

- Your run was launched with `--mock`, `rr-verify doctor` exits 0, and VS Code is connected: `rr-verify vscode launch` printed `status:    RocketRide: Connected (Direct)`, or you ran `rr-verify vscode connect` and it ended with `PASS: connect`. See [vscode.md](./vscode.md).
- `rr-verify tscli -- list` prints `No active tasks found`.

- **Open the quickstart pipeline.** Run `rr-verify vscode open quickstart-chat`. It clicks `quickstart-chat` in the Pipelines tab and waits for the canvas. It prints `ok   clicking it opens the canvas: editor: quickstart-chat`, `ok   dismiss the RocketRide Cloud prompt if it appears: dismissed`, and `ok   the canvas shows every node and connection in the file: 3 nodes, 2 connections`, and ends with `PASS: open`. `NAME` is a path under the workspace's `pipelines` folder without `.pipe`; pass `folder/name` for a pipeline elsewhere in the workspace.
- **Run it.** Run `rr-verify vscode run`. It presses Run on the first source node. It prints `ok   chat_1 shows it is running: the Run button turned into Stop` and `ok   chat_1 is ready: Chat / SOURCE / Questions / 0 done · <n>s / Chat ready - system is ready to accept questions / Chat now / Endpoint Info`, and ends with `PASS: run`. Pass `--node <id>` to press Run on another source node.
- **Confirm the task.** Run `rr-verify tscli --label canvas-run -- list`. It prints `Found 1 active task(s):` with `Source: chat_1` and `Status: Chat ready - system is ready to accept questions`.
- **Ask a question.** Run `rr-verify vscode chat "What is RocketRide?"`. It presses **Chat now**, which opens a `Chat` tab with `http://127.0.0.1:<port>/chat/5b0e6f2c-8d41-4a7e-9c3b-2e7f1a6d4c90/chat_1`, asks the question, and waits for the reply. It prints `ok   ask the question: Mock LLM response. This stub is used when ROCKETRIDE_MOCK is set so tests run without API keys or external services.` and `ok   the reply is an answer: an answer was returned`, and ends with `PASS: chat`. Under `--mock` the answer is always that text (mocked LLM). A second `chat` reuses the open chat tab.
- **Stop it.** Run `rr-verify vscode stop-pipeline`. It brings the pipeline's editor back to the front if the chat tab covers it, presses Stop, and prints `ok   chat_1 returns to idle`, then `PASS: stop-pipeline`. Then run `rr-verify tscli --label canvas-stop -- list`. It prints `No active tasks found`.
- **Drop Return Answers.** Run `rr-verify vscode open quickstart-chat-no-return`, then `rr-verify vscode run`, then `rr-verify vscode chat --label canvas-chat-no-return --expect none "What is RocketRide?"`. The chat step prints `ok   ask the question: I don't see any answers in there...` and `ok   the chat says the pipeline returned no answers: no answers returned, as expected`. Stop it with `rr-verify vscode stop-pipeline`.
- **Confirm the check can fail.** With `quickstart-chat-no-return` running, `rr-verify vscode chat --label canvas-chat-no-return-control "What is RocketRide?"` ends with `FAIL: chat: the reply is an answer` and exit code 1. This is the expected result.
- **Check your own pipeline.** Copy it into the workspace, such as `cp <path>.pipe .verify/$RR_VERIFY_ID/vscode-profile/workspace/pipelines/mine.pipe`, then run `rr-verify vscode open mine`, `rr-verify vscode run --node <source id>`, and the steps your change needs. A pipeline without `ui.position` on each component draws all its nodes on top of each other at the top left; add positions or press **Tidy layout** in the canvas toolbar.

## Gotchas

- **Run works in VS Code but not in the browser.** Pipeline Builder in the browser shell locks the Run button with `Subscription required` on an OSS engine. The VS Code canvas runs the same pipeline against the same engine.
- **The RocketRide Cloud prompt covers the canvas.** Opening or revealing a pipeline shows `Connect this pipeline to RocketRide Cloud` a moment later, and it blocks clicks on the nodes. The steps press **Dismiss** each time it shows. Do not press **Don't show again** in a run you also use for prompt checks.
- **Every Chat now opens a new tab.** The chat page is an iframe inside a webview tab named after the source node. `rr-verify vscode chat` reuses a chat tab that is in front and presses **Chat now** otherwise, so after `stop-pipeline` and another `run` a second `Chat` tab opens.
- **The Development tab hides the canvas.** A step that finds the editor on Development or Deploy switches back to Design first.
- **Stopping marks the task failed.** After Stop, **RocketRide: Server Monitor** lists the task as `failed (1)`, and the engine reports exit code 1 for it. This is pre-existing; the webhook feature's gotchas describe the same exit code.
- **Editing a stopped pipeline offers to restart it.** After Stop, writing the `.pipe` file in place (an edit saved from another editor) shows `Pipeline component "Chat" in quickstart-chat.pipe is running. Restart it?`, although `rr-verify tscli -- list` prints `No active tasks found`. The extension asks the engine for the task's token, and the engine still returns it for the stopped task, with `completed: True`. Answering **Yes** starts the pipeline again. Reproduced on 2026-10-27; it is pre-existing.
- **Stop leaves 66 errors and 3 warnings on the node.** After one chat and a Stop, the Chat node and its row in the Pipelines tab show 66 errors and 3 warnings. The engine reports its own thread cancellations as the task's errors, such as `Cancelled*Condition wait*Queue.hpp:179` and `Cancelled*Scanning path failed / : Cancelled ... Thread globally cancelled`, with warnings such as `Cancelled*Unable to flush endpoint queue chat`. `client.get_task_status()` on the stopped task returns the same 66 and 3. This is pre-existing on 2026-10-27; compare with a base-branch run before you report a change in the counts.
- **The canvas cannot be driven by drag and drop here.** Adding nodes and wiring lanes need pointer drags across nested webview frames, which no step does yet. Check canvas editing in the browser shell with [shell.md](./shell.md), which renders the same component, and use `rr-verify vscode script` with `page.mouse` for a VS Code-specific check.
