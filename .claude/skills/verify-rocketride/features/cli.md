# CLIs

Both SDKs ship a `rocketride` command. Users validate `.pipe` files, start and stop pipelines, upload files, and list running tasks with it. The Python CLI comes from `pip install rocketride`; the TypeScript CLI comes from `npm i rocketride`.

## Sub-features

- `cli-validate` reports each `.pipe` file as valid or invalid and exits 1 when any file is invalid.
- `cli-start` starts a pipeline, prints its token, and leaves it running.
- `cli-list` lists running tasks with name, token, source, status, and description, or says none are running.
- `cli-stop` terminates a task by token.
- `cli-upload` sends files to a pipeline and reports bytes uploaded.

## How to get to it (user POV)

- Install the Python package and run `rocketride <command>` with `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY` set.
- Install the npm package and run its `rocketride` binary with the same variables.

## Driving it with rr-verify

Preconditions:

- Your run is live and `rr-verify doctor` exits 0.
- `rr-verify tscli -- list` prints `No active tasks found`.
- `rr-verify cli` builds `.verify/venv` from the wheel in `dist/server/static/clients/python` on first use.

- **Validate pipelines.** Run `rr-verify cli --label cli-validate -- validate $F/echo.pipe $F/quickstart-chat.pipe $F/quickstart-chat-no-return.pipe`. Each file prints `<path>: valid`, the last line is `Summary: 3 file(s), 3 valid, 0 invalid`, and the exit code is 0.
- **Reject a broken pipeline.** Write a copy of `$F/echo.pipe` whose Return Text node reads from a component that does not exist: `python3 -I -c 'import json,sys; p=json.load(open(sys.argv[1])); p["components"][1]["input"][0]["from"]="missing_1"; open(sys.argv[2],"w").write(json.dumps(p))' $F/echo.pipe /tmp/rr-verify-$RR_VERIFY_ID-broken.pipe`. Run `rr-verify cli --label cli-validate -- validate /tmp/rr-verify-$RR_VERIFY_ID-broken.pipe`. It prints `/tmp/rr-verify-<run-id>-broken.pipe: invalid`, an indented `error: Component response_text_1 input references unknown component id: missing_1`, then `Summary: 1 file(s), 0 valid, 1 invalid`, and exits 1.
- **Start a pipeline.** Run `rr-verify cli --label cli-start -- start --pipeline $F/echo.pipe`. It prints `Pipeline started.` and `Token: tk_<hex>`, and exits 0. Keep the token.
- **List from Python.** Run `rr-verify cli --label cli-list -- list`. It prints `Found 1 active task(s):` with `Name: webhook_1`, `Token:` (the same token), `Source: webhook_1`, `Status: Webhook ready - system is ready to accept requests`, and a `Description:` line.
- **List from TypeScript.** Run `rr-verify tscli --label cli-list -- list`. It prints the same task.
- **Stop it.** Run `rr-verify cli --label cli-stop -- stop --token <token>`. It prints `Task <token> terminated.` and exits 0.
- **Confirm it stopped.** Run `rr-verify tscli --label cli-stop -- list` and `rr-verify cli --label cli-stop -- list`. Both print `No active tasks found`.
- **Upload.** Run `printf 'hello from verify\n' > /tmp/rr-verify-$RR_VERIFY_ID-hello.txt && rr-verify cli --label cli-upload -- upload --pipeline $F/echo.pipe /tmp/rr-verify-$RR_VERIFY_ID-hello.txt`. It prints `uploaded rr-verify-<run-id>-hello.txt (18 B)` and a line starting `Uploaded 1 of 1 file(s), 18 B`, and exits 0. `rr-verify tscli --label cli-upload -- list` then prints `No active tasks found`.

## Gotchas

- The Python CLI defaults to RocketRide's cloud (`https://api.rocketride.ai`) when `ROCKETRIDE_URI` is unset. The TypeScript CLI defaults to `localhost:5565`. `rr-verify cli` and `rr-verify tscli` always set it.
- `rr-verify cli` runs the CLI from the built wheel, as a user would after `pip install`. Running `dist/server/engine -m rocketride.cli` instead fails with `No module named 'rocketride_common'`.
- After editing the Python SDK, rebuild the wheel with `./builder client-python:wheel-source`. `rr-verify` reinstalls `.verify/venv` when the wheel changes.
- A task started from the CLI shows `Description: RocketRide DTC MCP Tool`, although MCP was not involved.
