# Webhook pipeline

A webhook pipeline accepts data sent to a running task and returns whatever its Return nodes collect. The echo fixture returns the text it receives, which makes it the smallest end-to-end check of starting a pipeline, sending data, reading a result, and terminating the task.

## Sub-features

- `webhook-send-text` returns the sent text on the `text` lane when it is sent as `text/plain`.
- `webhook-cli-upload` uploads a file to a pipeline from the CLI and reports the upload.
- `webhook-terminate` ends the task when the caller terminates it, leaving nothing running.

## How to get to it (user POV)

- Call `client.use(filepath=...)`, then `client.send(token, data, objinfo=..., mimetype=...)`, then `client.terminate(token)` from the Python SDK.
- Run `rocketride upload --pipeline <file.pipe> <files>` from the CLI.
- POST to the engine's `/webhook` endpoint, as the n8n nodes do. This skill does not drive that path yet.

## Driving it with rr-verify

Preconditions:

- Your run is live and `rr-verify doctor` exits 0. `--mock` is not needed for the echo fixture.
- `rr-verify tscli -- list` prints `No active tasks found`.

- **Send text.** Run `rr-verify send --label webhook-send-text --pipe $F/echo.pipe --expect-text "hello from verify" "hello from verify"`. The result has `"text": ["hello from verify\n\n"]`, and the output ends with `PASS: result text contains 'hello from verify'`.
- **Confirm termination after send.** The send's output shows `token: tk_...  terminated: True`, so the task was started and then terminated. Run `rr-verify tscli --label webhook-terminate -- list`. It prints `No active tasks found`.
- **Upload from the CLI.** Run `printf 'hello from verify\n' > /tmp/rr-verify-hello.txt && rr-verify cli --label webhook-cli-upload -- upload --pipeline $F/echo.pipe /tmp/rr-verify-hello.txt`. It prints `uploaded rr-verify-hello.txt (18 B)` and `Uploaded 1 of 1 file(s)`, and exits 0.
- **Confirm termination after upload.** Run `rr-verify tscli --label webhook-terminate -- list`. It prints `No active tasks found`, because `upload --pipeline` stops the task it started.

## Gotchas

- Send text as `text/plain`, which `rr-verify send` does. Data sent without a mimetype comes back with no `text` field on an engine built without the C++ `parse` node. It is not yet confirmed whether a full build changes that.
- The echo result appends two newlines to the text. Match with "contains", not equality.
- `rocketride upload` reports bytes sent, not the pipeline's result. Use `rr-verify send` when the result is the proof.
- Every start of `echo.pipe` gets the same task token, on any engine. A task left over from an earlier step makes the next start fail with `Pipeline is already running.`
