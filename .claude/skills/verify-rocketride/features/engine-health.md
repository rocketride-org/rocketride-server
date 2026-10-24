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

- A run is live and `rr-verify doctor` has not been run against it yet, or you want a fresh check.

- **Check everything at once.** Run `rr-verify doctor`. Every line starts with `ok` or `info`, and the exit code is 0.
- **Read the version.** Run `. .verify/<run-id>/engine.env && curl -s "$ROCKETRIDE_URI/version"`. The JSON has `"status":"OK"` and `data.hash` equal to the first 8 characters of the commit the engine was built from.
- **Confirm freshness.** In the doctor output, `ok   no engine, ai, or node changes since the build` means the engine runs this checkout's code. A `WARN` line names the rebuild command to run before verifying.
- **Reject a wrong key.** Run `curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer wrong' "$ROCKETRIDE_URI/task"`. It prints `401`.
- **Accept the right key.** Run `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ROCKETRIDE_APIKEY" "$ROCKETRIDE_URI/task"`. It prints `422`, because the request passed auth and then lacked a `token` parameter.

## Gotchas

- `/ping` is not a health endpoint. It returns 401 without a key and 404 with one. Use `/version`, which needs no key.
- `/version` reports the commit the engine binary was built from. Python changes synced later with `./builder ai:sync nodes:sync` do not change it, which is why doctor compares files, not only hashes.
- An engine started with `--autoterm` exits as soon as its stdin closes. `rr-verify launch` does not pass it. Do not add it when launching by hand from an agent shell.
- When `ROCKETRIDE_APIKEY` is unset in the engine's environment, the engine accepts any key. `rr-verify launch` always sets it, so a missing key still fails.
