# CLIs

Both SDKs ship a `rocketride` command. Users validate `.pipe` files, start and stop pipelines, upload files, and list running tasks with it. The Python CLI comes from `pip install rocketride`; the TypeScript CLI comes from `npm i rocketride`.

## Sub-features

- `cli-validate` reports each `.pipe` file as valid or invalid and exits non-zero when any file is invalid.
- `cli-upload` sends files to a pipeline and reports bytes uploaded.
- `cli-list` lists running tasks with name, token, source, and status.

## How to get to it (user POV)

- Install the Python package and run `rocketride <command>` with `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY` set.
- Install the npm package and run its `rocketride` binary with the same variables.

## Driving it with rr-verify

Preconditions:

- A run is live and passes `rr-verify doctor`.
- `rr-verify sdk` has built `.verify/venv` from the wheel in `dist/server/static/clients/python`. `rr-verify cli` does this on first use.

- **Validate pipelines.** Run `rr-verify cli -- validate $F/*.pipe`. Each file prints `<path>: valid`, the summary reads `3 file(s), 3 valid, 0 invalid`, and the exit code is 0.
- **Reject a broken pipeline.** Write a copy of `$F/echo.pipe` whose response node reads from a component that does not exist: `python3 -I -c 'import json,sys; p=json.load(open(sys.argv[1])); p["components"][1]["input"][0]["from"]="missing_1"; open("/tmp/rr-verify-broken.pipe","w").write(json.dumps(p))' $F/echo.pipe`. Run `rr-verify cli -- validate /tmp/rr-verify-broken.pipe`. It prints `/tmp/rr-verify-broken.pipe: invalid` and `error: Component response_1 input references unknown component id: missing_1`, then `1 file(s), 0 valid, 1 invalid`, and exits 1.
- **Upload.** Follow `webhook-cli-upload` in [the webhook feature](./webhook-pipeline.md).
- **List tasks from Python.** Run `rr-verify cli -- list`. With nothing running it prints `No active tasks found`.
- **List tasks from TypeScript.** Run `rr-verify tscli -- list`. It prints the same thing. While a task is running it prints `Found 1 active task(s):` with the task's name, token, source, and status.

## Gotchas

- The Python CLI defaults to RocketRide's cloud (`https://api.rocketride.ai`) when `ROCKETRIDE_URI` is unset. The TypeScript CLI defaults to `localhost:5565`. `rr-verify cli` and `rr-verify tscli` always set it.
- `rr-verify cli` runs the CLI from the built wheel, as a user would after `pip install`. Running `dist/server/engine -m rocketride.cli` instead fails with `No module named 'rocketride_common'`.
- After editing the Python SDK, rebuild the wheel with `./builder client-python:wheel-source`. `rr-verify` reinstalls `.verify/venv` when the wheel changes.
