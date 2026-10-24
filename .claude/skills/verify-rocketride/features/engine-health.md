# Engine health

A running engine reports its version and the commit it was built from, rejects requests without the right API key, and accepts requests with it. Every other feature depends on this one.

## Sub-features

- `health-version` returns `status: OK` with the version, the build commit hash, and the build time.
- `health-freshness` shows whether the engine was built from the code in this checkout.
- `health-auth-reject` rejects a missing or wrong API key with HTTP 401.
- `health-auth-accept` lets the configured API key through.

## How to get to it (user POV)

- Open `http://127.0.0.1:<port>/version` in a browser or with `curl`.
- Connect any SDK or CLI with `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY`.
- In VS Code, the "Rocket Ride: Extension" output channel prints `Engine ready (port N)`. This skill cannot drive VS Code yet.

## Driving it with rr-verify

Preconditions:

- Your run is live.

- **Run doctor.** Run `rr-verify record engine-health -- rr-verify doctor`. After the first line, `run <run-id>`, every line starts with `ok` or `info`, and the exit code is 0. Note the hash in the line `ok   dist/server matches this checkout's engine, ai, and node code (engine built from <hash>)`.
- **Read the version.** Run `rr-verify record engine-health -- curl -s "$ROCKETRIDE_URI/version"`. The JSON has `"status":"OK"`, and `data.hash` equals the hash in doctor's `engine built from` line. `git cat-file -t <hash>` prints `commit`.
- **Confirm freshness.** Doctor's `ok   dist/server matches this checkout's engine, ai, and node code` line means the engine runs this checkout's code. A `WARN` line names the rebuild or sync command to run first; report the feature as not verified until you run it and launch a new run.
- **Reject a wrong key.** Run `rr-verify record engine-health -- curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' "$ROCKETRIDE_URI/task"`. It prints `401`.
- **Reject a missing key.** Run `rr-verify record engine-health -- curl -s -o /dev/null -w '%{http_code}' "$ROCKETRIDE_URI/task"`. It prints `401`.
- **Accept the right key.** Run `rr-verify record engine-health -- curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ROCKETRIDE_APIKEY" "$ROCKETRIDE_URI/task"`. It prints `422`, because the request passed auth and then lacked a `token` parameter.

## Gotchas

- `/version` reports the commit the engine was built from, not the checkout's `HEAD`. On a branch with new commits they differ; compare with doctor's freshness line instead.
- `/ping` is not a health endpoint. It returns 401 without a key and 404 with one. Use `/version`, which needs no key.
- Python changes synced with `./builder ai:sync nodes:sync` do not change `/version`. Doctor compares each changed ai or node file with its copy in `dist/server` instead, so it stops warning once the sync is done.
- An engine started with `--autoterm` exits as soon as its stdin closes. `rr-verify launch` does not pass it. Do not add it when launching by hand from an agent shell.
- When `ROCKETRIDE_APIKEY` is unset in the engine's environment, the engine accepts any key. `rr-verify launch` always sets it, so a missing key still fails.
