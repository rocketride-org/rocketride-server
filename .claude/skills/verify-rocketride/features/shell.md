# Shell and Pipeline Builder

The engine serves the shell, its browser UI, at `/`. Signed out, the home page lists the shell apps the engine seeded from `apps.json`. Signing in with the engine's API key connects the shell, and each app opens inside it. Pipeline Builder is the shell app with the canvas editor: a user starts a pipeline from a source and adds and connects nodes on the canvas.

## Sub-features

- `shell-home` shows `Welcome to RocketRide` and one tile per shell app, with every app icon loaded and no console errors.
- `shell-sign-in` refuses a wrong API key with `Invalid API key`, signs in with the run's key, and signs out again.
- `canvas-new-pipeline` starts a new pipeline from a source and puts the source's node on the canvas.
- `canvas-node-icon` shows each node's icon in its header after the node's settings have loaded.

## How to get to it (user POV)

- Open `http://127.0.0.1:<port>/` in a browser, where the port is the engine's. A desktop install and a self-hosted engine serve the same shell.
- Click a tile, such as `Pipeline Builder`, to open that app. Most apps need **Sign In** first.
- The VS Code extension draws pipelines with the same canvas component in an editor tab. See [vscode-canvas.md](./vscode-canvas.md).

## Driving it with rr-verify

Preconditions:

- Your run is live and `rr-verify doctor` exits 0. `--mock` is not needed.
- Doctor prints `ok   this run serves UIs built from this checkout's current source` and no `WARN` line for `shell` or `rocket-ui` (Pipeline Builder). A `WARN` line names the build to run; run it, then launch a new run.

- **Open the home page.** Run `rr-verify browse --label shell-home $F/browser/shell-home.mjs`. It counts the app tiles (`count role=button[name=/^Open /] -> 9` on this branch), checks that no app icon failed to load, saves `<time>-home.png`, and ends with `PASS: 8 step(s) passed`.
- **Sign in and out.** Run `rr-verify browse --label shell-sign-in $F/browser/shell-sign-in.mjs`. It enters `wrong-key` and waits for `Invalid API key`, cancels, signs in with the run's key, waits for `Connected`, signs out, and ends with `PASS: 14 step(s) passed`. The screenshots are `<time>-wrong-key.png`, `<time>-signed-in.png`, and `<time>-signed-out.png`.
- **Add a node.** Run `rr-verify browse --label canvas-node $F/browser/canvas-node.mjs`. It signs in, opens Pipeline Builder, clicks **New pipeline**, picks **Chat**, opens and closes the node's settings, and counts the icon in the node header. The output has `count .react-flow__node >> visible=true >> .rr-node-header > div:first-child :is(svg, img) -> 1` and ends with `PASS: 19 step(s) passed`. To start from another source, pass its button text, such as `rr-verify browse --label canvas-node $F/browser/canvas-node.mjs Webhook`.
- **Check your own change.** Copy the closest script to `/tmp/rr-verify-$RR_VERIFY_ID-<name>.mjs`, edit the steps, and run it with `rr-verify browse --label <feature-id> /tmp/rr-verify-$RR_VERIFY_ID-<name>.mjs`. Add `await snapshot('page');` where you need the roles and names on the page; it prints the accessibility tree. `rr-verify browse --help` lists every helper.

## Gotchas

- **Pipeline Builder often crashes when you pick a source.** In about half the attempts, clicking a source such as **Chat** right after **New pipeline** replaces the app with `Pipeline Builder encountered an error` and `Minified React error #185` (maximum update depth). The canvas recipe then fails at `check Pipeline Builder did not crash`. This is a known product bug, reproduced on 2026-10-27 with plain Playwright and no recording. Run the recipe again. Report the crash as a defect only when your change touches it, and name it as pre-existing otherwise.
- **The canvas cannot run pipelines in OSS.** The Run button on a source node shows a lock titled `Subscription required`, and clicking it does nothing. Pipeline Builder accepts only a `subscribed` or `trialing` app status, and an OSS engine marks every app `free`. Run pipelines through the SDK, a CLI, or MCP instead, as the other features do.
- After a wrong key and **Cancel**, the shell shows `Your session has expired. Please sign in again.` although nobody was signed in. This is pre-existing; the sign-in recipe passes through it.
- Pipeline Builder keeps every tab it opened (`Untitled-1`, `Untitled-2`, ...) in the page, with hidden canvases, and saves the open tabs in the run's store, so later browse runs on the same run reopen them. Add `>> visible=true` to a selector that would also match a hidden tab. `waitText` and `waitFor` already ignore hidden matches.
- The browser loads shell app bundles from the run's store, which `rr-verify launch` seeds from `dist/server/static/apps` when the engine starts. After you rebuild an app, launch a new run. The shell itself, `/chat`, and `/dropper` are read from `dist/server/static` on every request, so a rebuild shows on the next browse run.
- Engines that share `~/.rocketlib/store` show apps that other checkouts seeded there, with broken icons, and load those checkouts' bundles. `rr-verify launch` gives each run its own store under `.verify/<run-id>/store` for this reason. Never drive an engine you did not launch with `rr-verify`.
- The shell and the docs site fetch the repository's star count from `api.github.com`, which answers 403 when the address is rate-limited. `rr-verify browse` ignores that request. Pass `--ignore REGEX` to ignore other noise, and say so in the PR.
