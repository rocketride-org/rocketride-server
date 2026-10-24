# Webhook pipeline

A webhook pipeline accepts data sent to a running task and returns whatever its response nodes collect. The echo fixture returns the text it receives, which makes it the smallest end-to-end check of starting a pipeline, sending data, and reading a result.

## Sub-features

- `webhook-send-text` returns the sent text on the `text` lane when it is sent as `text/plain`.
- `webhook-cli-upload` uploads a file to a pipeline from the CLI and reports the upload.
- `webhook-terminate` leaves no task running after the caller terminates it.

## How to get to it (user POV)

- Call `client.use(filepath=...)`, then `client.send(token, data, objinfo=..., mimetype=...)`, then `client.terminate(token)` from the Python SDK.
- Run `rocketride upload --pipeline <file.pipe> <files>` from the CLI.
- POST to the engine's `/webhook` endpoint, as the n8n nodes do. This skill does not drive that path yet.

## Driving it with rr-verify

Preconditions:

- A run is live and passes `rr-verify doctor`. `--mock` is not needed for the echo fixture.
- `rr-verify tscli -- list` prints `No active tasks found`.

- **Send text.** Run `rr-verify send --pipe $F/echo.pipe --expect-text "hello from verify" "hello from verify"`. The result has `"text": ["hello from verify\n\n"]`, and the output ends with `PASS: result text contains 'hello from verify'`.
- **Upload from the CLI.** Run `printf 'hello from verify\n' > /tmp/rr-verify-hello.txt && rr-verify cli -- upload --pipeline $F/echo.pipe /tmp/rr-verify-hello.txt`. It prints `Uploaded 1 of 1 file(s)` and exits 0.
- **Confirm termination.** Run `rr-verify tscli -- list`. It prints `No active tasks found`.
- **Proof.** Each `send` saves `.verify/<run-id>/webhook-pipeline/<time>-send.json`.

## Gotchas

- Send text as `text/plain`, which `rr-verify send` does. Data sent without a mimetype comes back with no `text` field on an engine built without the C++ `parse` node. It is not yet confirmed whether a full build changes that.
- The echo result appends two newlines to the text. Match with "contains", not equality.
- `rocketride upload` reports bytes sent, not the pipeline's result. Use `rr-verify send` when the result is the proof.
