# Dropper page

The engine serves the dropper page (`apps/dropper-ui`) at `/dropper`. Opened with `?auth=<public key>` of a running pipeline with a Dropper source, it uploads the files a user drops or picks, lists them, and shows what the pipeline returns for each file in tabs such as Text and JSON. Removing a file removes its result.

## Sub-features

- `dropper-upload` uploads a file and shows the text the pipeline returns for it.
- `dropper-remove` removes a file from the list together with its result.
- `dropper-mcp-url` opens the `dropper_url` that MCP's `run_dropper_pipe` returns and uploads through it.

## How to get to it (user POV)

- Run a pipeline with a Dropper source in VS Code and drop files on its panel. `rr-verify vscode` can open and run such a pipeline, but no recipe drops files on its panel yet.
- Open `http://127.0.0.1:<port>/dropper?auth=<public key>` in a browser. The public key is the `publicToken` that `client.use()` returns for the task.
- Ask an MCP client to run a dropper pipeline. `run_dropper_pipe` returns a `dropper_url` to hand to the user.

## Driving it with rr-verify

Preconditions:

- Your run is live and `rr-verify doctor` exits 0, with no `WARN` line for `dropper-ui`. `--mock` is not needed.
- `dist/server/nodes/parse/libparse.so` exists. `$F/dropper-text.pipe` is Dropper, then Parse, then Return Text, and Parse is a C++ node.
- `rr-verify tscli -- list` prints `No active tasks found`.

- **Upload and remove a file.** Run `rr-verify browse --label dropper-upload $F/browser/dropper-ui.mjs`. It starts `$F/dropper-text.pipe`, opens `/dropper?auth=pk_...`, uploads a text file holding `hello from the dropper page`, waits for that text in the result, removes the file, waits until the text is gone, and terminates the task. The output ends with `PASS: 16 step(s) passed`. `<time>-result.png` shows the file and its Text tab; `<time>-removed.png` shows only the drop area.
- **Upload other text.** Pass the pipeline and the text: `rr-verify browse --label <feature-id> $F/browser/dropper-ui.mjs $F/dropper-text.pipe "<text>"`.
- **Use the MCP link.** Run `rr-verify mcp --label dropper-mcp-url tools/call "{\"name\":\"run_dropper_pipe\",\"arguments\":{\"pipeline\":$(tr -d '\n\t' < $F/dropper-text.pipe)}}"`. Keep `task_token` and `dropper_url` from `structuredContent`. Run `rr-verify browse --label dropper-mcp-url $F/browser/dropper-ui.mjs "<dropper_url>" "hello through mcp"`. The output ends with `PASS: 14 step(s) passed`; the script does not start or stop a task when you pass a URL. Then run `rr-verify mcp --label dropper-mcp-url tools/call '{"name":"terminate","arguments":{"task_token":"<task_token>"}}'`; `structuredContent` has `"terminated": "<task_token>"`.
- **Confirm cleanup.** Run `rr-verify tscli --label dropper-cleanup -- list`. It prints `No active tasks found`.

## Gotchas

- A wrong or stale public key leaves the page on `Connecting...` and `Please wait` with no error message. The only sign is the console error `Failed to start client: AuthenticationException: Bad request`. This is pre-existing (confirmed 2026-10-27).
- The recipe sets the files on the page's file input, which is what picking files in the file dialog does. Dragging files from the desktop onto the page is not covered.
