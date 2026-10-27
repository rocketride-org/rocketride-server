---
name: rr-verify-agent
description: Prove browser agent behavior in the real app. Covers only the Agent tab of Rocket Builder (apps/shared/src/modules/agent, apps/shared/src/tools/agent, the rocket-ui workspace it edits), not the rest of the repo. Starts an engine (built from this checkout through verify-rocketride's launcher, or the published image), the branch's rocket-ui and shell, drives the Agent tab with Playwright like a user, and records screenshots, the files the agent wrote read back through the engine, the chat, the console, the WebSocket frames the page sent and the engine's provenance. Use it to prove a browser agent PR works before review, or to reproduce an agent bug end to end.
---

# Verify the browser agent

This skill drives the Agent tab of Rocket Builder in a real browser, against a real engine and a real model. It covers the browser agent only. The feature map in `features/` lists what it can prove. Read `features/README.md` before driving anything.

Run everything from the repository root of the checkout you want to verify. The skill serves that checkout's `apps/rocket-ui` and `packages/shell`, so check out the PR branch first.

```bash
S=.agents/skills/rr-verify-agent/scripts
$S/rr-verify-agent build-engine --release nearest       # once per checkout: dist/server for --engine source
$S/rr-verify-agent run build-pipeline stop              # lock, launch, drive each journey, clean up
```

`run` is the usual way in. The single steps are there for driving by hand:

```bash
$S/rr-verify-agent launch [--engine source|image]   # engine + branch rocket-ui + branch shell
$S/rr-verify-agent doctor                           # read-only health check; run it whenever anything looks off
$S/rr-verify-agent drive <journey>                  # build-pipeline | secrets | unsaved-edits | needs-you | stop | team-switch | steps <file or name>
$S/rr-verify-agent engine <cmd>                     # read the workspace through the engine (ls, cat, validate, probe, whoami, snapshot)
$S/rr-verify-agent cleanup                          # stop only what launch started; evidence stays
$S/rr-verify-agent keys <cmd> [...]                 # run a command with the model keys, found the way launch finds them
```

## One run per machine

The shell's dev proxy pins the engine at `localhost:5565` (packages/shell/rsbuild.config.mts), and the dev servers use ports 3000 and 3010. So only one run can drive at a time on a machine, whichever checkout it comes from.

- `run` holds `/tmp/rr-verify-5565.lock` from launch to cleanup. It waits while another run holds it. Don't wrap `run` in another `flock` on the same file, because that deadlocks.
- When you drive by hand, wrap the whole block in the lock:

  ```bash
  flock /tmp/rr-verify-5565.lock bash -c 'S=.agents/skills/rr-verify-agent/scripts; $S/rr-verify-agent launch && $S/rr-verify-agent drive build-pipeline; $S/rr-verify-agent cleanup'
  ```
- `launch` refuses to start when 5565, 3000 or 3010 is held by anything it did not start. Never stop someone else's engine or container to make room.

`run` takes each journey as one argument. Quote a journey that has flags:

```bash
$S/rr-verify-agent run build-pipeline "unsaved-edits --choice save" "steps closed-dirty-tab"
```

Its exit code is the worst result: 1 a failure, 2 a journey that could not run, 3 a journey that passed every check this engine can verify, 0 all passed.

## The engine

`launch` starts one of two engines and records which one it got.

- **`--engine source` (the default).** The engine in this checkout's `dist/server`, started by verify-rocketride's launcher on port 5565. Its Python (`packages/ai`, `nodes`) is this checkout's, so engine changes on the branch run, including `fs_put_json`, which chat session saves need.
- **`--engine image`.** The published image `ghcr.io/rocketride-org/rocketride-engine:3.5.0` (the same digest as `latest` on 2026-10-27), in a fresh container with no volume. Its Python is the release's. It has no `fs_put_json`, so the chat cannot save sessions on it. Override the tag with `RR_VERIFY_IMAGE`.

### Fallback

`--engine source` needs two things in the checkout. When either is missing, `launch` prints "CANNOT START THE ENGINE FROM SOURCE" with the reason and the fix, then starts the image instead.

1. **verify-rocketride's launcher** at `.claude/skills/verify-rocketride/bin/rr-verify`. It starts `dist/server` of the checkout it sits in, so a copy in another checkout would start the wrong engine. Until verify-rocketride is merged into this branch, copy that skill folder from branch `feat/verify-rocketride-headless` into `.claude/skills/verify-rocketride/`. Git ignores `.claude/*`, so the copy stays local. Delete the copy before merging a branch that tracks it. `RR_VERIFY_LAUNCHER` points at another path in this checkout.
2. **An engine in `dist/server`.** See the next section.

Every journey then reports the checks that read saved sessions as "not verifiable on this engine", never as a pass or a silent fail. `drive` decides that from the engine's own answer, not from the mode: `launch` writes a probe file with `fs_put_json` and reads it back (`rr-verify-agent engine probe`).

### Building dist/server

`rr-verify-agent build-engine` fills `dist/server`:

1. It runs `./builder server:download`. When a server release matches this checkout's `packages/server` source, that release's binary is downloaded, and the binary is this checkout's C++.
2. When no release matches, it stops and lists the nearest release tags. Two ways on:
   - Compile: `./builder server:build --autoinstall`. It needs root once for system packages (`sudo ./scripts/compiler-unix.sh --autoinstall`) and takes from 10 minutes to a few hours. See verify-rocketride's SKILL.md.
   - `--release nearest` (or `--release <tag>`): put the release binary with the smallest `packages/server` diff in `dist/server`.
3. Either way it then syncs this checkout's engine Python and nodes into `dist/server` (`./builder --sequential server:setup-pip nodes:sync ai:sync server:setup-test-deps client-typescript:build`), as `server:build` does after a download. The sync deletes nothing, so it then removes the copies of files that the release ships and this checkout deleted.

It writes `dist/server/.rr-verify-agent-build.json`: where the binary came from, its release tag and build hash, its C++ diff from the checkout, and the commit the Python came from. Rerun it after pulling engine changes. For a Python edit, `./builder --sequential ai:sync nodes:sync` is enough.

On feat/rocket-agent-browser at fda7c679, no release matches. `--release nearest` picks `server-v3.5.0`, whose `packages/server` differs from the branch in two files: a libstdc++ preload in `engine-core/apLib/plat/lin/init.cpp` that 3.5.0 has and the branch lacks, and a test. The download and sync take 50 to 70 seconds.

With a release binary, verify-rocketride's doctor (shown by `doctor` and kept in `engine.json`) prints three WARN lines that are expected:
- C++ files changed since the build: the binary's diff from the checkout, also in the build record.
- 3 ai or node files differ from `dist/server`: the MCP viewer app sources under `ai/modules/mcp/apps`, which `ai:sync` never copies. They are not engine code.
- Python SDK sources newer than the wheel: the wheel serves verify-rocketride's Python drivers. This skill uses the TypeScript client.

Any other WARN means `dist/server` is stale: rerun `build-engine`.

### Provenance

`launch` writes `.verify/agent-state/engine.json`, and every evidence folder gets a copy as `engine.json` plus an `engine` field in `result.json`:

- `mode` (`source` or `image`), what was requested, and the fallback reason if there was one
- the checkout's commit, branch and count of changed files
- for source: the launcher's path, its sha256 and run id, the engine pid, the store, the build record above, the builder's state hashes, and the launcher's own `doctor` lines (whether `dist/server` matches the checkout's engine, ai and node code)
- for image: the tag, the image id and its repo digests
- the engine's `/version` answer
- `capabilities.fsPutJson`, from the probe
- the key source (environment, tokenstash or none) and the Variable names given to the engine, never values

## Launch

`rr-verify-agent launch` does all of this, in order, and stops with a reason on the first failure:

1. Refuses to start if port 5565, 3000 or 3010 is in use (see above). Override the dev ports with `RR_VERIFY_SHELL_PORT` and `RR_VERIFY_UI_PORT`.
2. Installs what is missing, once per checkout: `CI=true pnpm install --frozen-lockfile`, `./builder client-typescript:build` (the engine reader needs it), and the Playwright helper in `scripts/` (its own package.json, Playwright 1.63.0, never a product dependency).
3. Starts the engine with empty data. For source, a fresh launcher run (`.verify/agent-<time>-<pid>/`) with a file store of its own, `.verify/agent-state/store` (`RR_STORE_URL`), emptied at each launch. The engine's default store is `~/.rocketlib`, which every local engine of this user shares, and each journey's reset deletes all workspace files and sessions in its store. For image, a fresh container `rr-verify-agent-engine` (label `rr-verify-agent=1`) with no volume. `ROCKETRIDE_APIKEY=local-test` is a local-only test key, not a secret.
4. Gives the engine the model keys by name only (see Keys).
5. Waits until the engine is usable: `/version` answers and a signed-in client can list the store. Then records the provenance.
6. Writes two generated rsbuild wrappers into the gitignored `.rocketride/` folders:
   - `apps/rocket-ui/.rocketride/verify.rsbuild.config.mts` serves the branch's rocket-ui under `/apps/rocketride.pipeBuilder/dev/`, the URL-convention dev prefix (the same shape as apps/vscode/src/appdev/proxyConfig.ts).
   - `packages/shell/.rocketride/verify.rsbuild.config.mts` adds one proxy rule first, sending that prefix to the rocket-ui dev server.
7. Starts both dev servers in their own process groups (recorded in `.verify/agent-state/*.pgid`). Ready means `http://127.0.0.1:3000/apps/rocketride.pipeBuilder/dev/package.json` comes back through the shell with `"id": "rocketride.pipeBuilder"`.
8. Runs `doctor`.

The page to drive is `http://127.0.0.1:3000/?appid=rocketride.pipeBuilder&rrdev=1`. `rrdev=1` makes the shell self-register the branch's rocket-ui from the dev prefix instead of the engine's published bundle.

`rr-verify-agent launch --dev-only` starts only the two dev servers, with no engine. Use it as a compile check while another run owns 5565. Never open the page in that mode, because the shell would talk to the other run's engine. `drive` and `engine` refuse to run unless the engine on 5565 is this checkout's.

`rr-verify-agent launch --engine-only` starts the engine alone, with its provenance, and no browser or dev servers. The eval runner's L3 (`shared:eval`, apps/shared/src/modules/agent/eval/README.md) starts its engine this way, under the same lock, and stops it with `cleanup`.

## Keys

The Agent tab's model call is the engine's stand-in pipeline, which needs `ROCKETRIDE_ANTHROPIC_KEY`. `launch` looks for keys in this order and stops at the first source that has one:

1. The environment: `ROCKETRIDE_ANTHROPIC_KEY` and `ROCKETRIDE_OPENAI_KEY`, or `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, which it renames.
2. tokenstash, when it is installed: `tokenstash run --retries 0` in `RR_VERIFY_KEYS_DIR` (default: the checkout root), which loads that project's env file. If a key is missing there, ask for it with `tokenstash need ANTHROPIC_API_KEY` from that folder.
3. None. `launch` warns, and only checks that need no model work.

Values stay in process environments. They never reach argv, logs, evidence or this skill's files; `.verify/agent-state/engine-vars.txt` holds only the names. Never ask for a key in chat and never invent one. `RR_VERIFY_NO_KEYS=1` starts the engine with no keys.

## Doctor

`rr-verify-agent doctor` changes nothing. It checks:
- the engine is ours: our labeled container, or the launcher's engine process still owning 5565
- `/version` answers, and a signed-in client can use the engine
- the model key Variable was given (by name)
- for source, verify-rocketride's own doctor: process, port, auth, and whether `dist/server` matches the checkout
- both dev server process groups are alive, `remoteEntry.js` is served, the shell page loads and proxies the dev manifest
- the checkout is still at the launched revision

Exit code 0 means drive. Anything else: read the FAIL lines, run `cleanup`, then `launch`. If the engine checks are skipped because 5565 belongs to another run, stop there.

## Drive

`rr-verify-agent drive <journey>` runs one journey in headless Chromium (`--headed` to watch). It uses the real user path:
1. Shell home, `Sign In`, the API key screen.
2. The app URL.
3. The `Agent` rail tab, the `New session` button.
4. The `Reply to the agent...` composer and `Send`.

Each journey first clears the engine's workspace files, agent sessions and saved workbench layout with `rr-verify-agent engine reset`, then seeds its own fixtures through the engine. The layout (`.workspace/rocketride.pipeBuilder.workspace.json`) would otherwise carry open tabs into the next journey. Journeys and what they check are in `features/`.

Handles used, in order of preference:
- **ARIA:** tabs by name (`Explorer`, `Agent`, `Pipelines`), buttons (`Sign In`, `New session`, `Send`), textboxes (`API key`, `Reply to the agent...`), dialogs by role.
- **The typing indicator:** it has no handle. The driver matches its inline animation (`span[style*="rr-chat-dot"]`). Turn end means those dots are gone.
- **Several composers:** each open session tab has its own. The driver only uses the visible one.
- **Rail tabs:** the first click after the app loads is swallowed while the app restores its default view. The driver clicks until `aria-selected="true"`.
- **Monaco text:** Monaco renders spaces as non-breaking spaces. The driver normalizes them before comparing.

For a path no journey covers, write a steps file and run `rr-verify-agent drive steps <file.json>`, or name one kept in `steps/` (`steps closed-dirty-tab`). See `steps/README.md` for the actions.

Handles to add in our PRs so journeys stop leaning on styles:
- `data-testid="chat-typing"` on TypingIndicator (packages/shell/src/components/chat/components/TypingIndicator.tsx)
- `data-testid="chat-message"` with `data-sender` on each MessageBubble row
- `data-testid="chat-status"` with `data-sse-type` on status rows, which the turn result row (PR C) will use
- `role="treeitem"` and an `aria-label` with the workspace path on Explorer rows (packages/shell/src/modules/explorer/Explorer.tsx)
- a dirty marker on editor tabs: `data-testid="editor-tab"` with `data-dirty`
- `data-testid="agent-stop"` on the Stop control

## Evidence

Every run writes to `$RR_VERIFY_EVIDENCE/<journey>/<UTC timestamp>/`. The default is `<checkout>/.verify/agent/`, which git ignores. Cleanup never touches it.
- `steps.log`: each user action and what it produced, with time stamps.
- `NN-<label>.png` and `NN-<label>.aria.txt`: a screenshot and an ARIA snapshot after every action and every turn end.
- `engine-final/`: the workspace files and agent session JSON read back through the engine, a second view that does not trust the page.
- `validate-<file>.json`: the engine's validate result for each pipeline the agent wrote.
- `transcript.txt`: the page text after the journey.
- `console.log`: browser console and page errors.
- `ws-sent.jsonl`: every WebSocket frame the page sent. For the browser side this is the boundary to the model, because the agent's model question leaves the page here.
- `engine.json`: the engine's provenance (see above).
- `result.json`: `status` (`pass`, `fail` or `incomplete`), each check with its status (`pass`, `fail` or `not-verifiable`) and reason, the engine's provenance, the checkout under test, frame counts and canary hits.

`incomplete` means no check failed and at least one could not be verified on this engine. Exit codes: 0 pass, 1 fail, 2 could not run, 3 incomplete. Report an incomplete journey as incomplete, with the checks it could not verify, never as a pass.

Proof standards:
- Drive the real user path. Never call internal setters, test endpoints or the agent API directly. Fixtures are seeded through the engine as preconditions only, never as the thing being proved.
- Capture the action and the resulting state: the screenshot after Send and after the turn, plus the files read back through the engine.
- Verify side effects, not only the chat. A pipeline counts when the file exists in the store and the engine validates it, not when the reply says so.
- Evidence scrubbing blanks real key shapes (`sk-ant-...`, `sk-...`) in everything written. The fake canaries of the secrets journey stay visible on purpose, so a leak shows in the files.
- A journey that cannot reach its precondition fails with the reason. It never passes by taking a different path.
- Name the engine with every result: `engine.json`'s `summary` line says which one it was.

## Cleanup

`rr-verify-agent cleanup` stops the two dev server process groups it recorded. For source it asks the launcher to stop its run, which ends the engine's process group. For image it removes `rr-verify-agent-engine`, but only when that container carries the `rr-verify-agent=1` label. It saves the engine log to `.verify/agent-state/engine-last.log` with keys blanked, and blanks keys in the launcher's own copy too. It removes the generated wrapper configs. It never kills by process name and never touches evidence. Run it after every run, failed ones included. `run` does it for you.

## Helpers

All helpers are in `scripts/`, executable, and called through `rr-verify-agent`:

| Helper | What it does |
|---|---|
| `rr-verify-agent` | The entry point. `run` holds the lock. `drive` and `engine` refuse unless the engine on 5565 is this checkout's. |
| `launch.sh`, `doctor.sh`, `cleanup.sh`, `lib.sh` | Launch, check, tear down, shared settings. |
| `build-engine.sh` | Fills `dist/server` for `--engine source` and writes the build record. |
| `keys-exec.sh` | Gives the model keys the engine's names and records which names are set. |
| `provenance.cjs` | Writes `engine.json`. |
| `drive.mjs` | Playwright journeys and the steps runner. `node scripts/drive.mjs <journey> [--headed] [--turn-timeout-min 20]`. |
| `engine-read.cjs` | `ping`, `probe`, `whoami`, `ls <path>`, `cat <path>`, `validate <path>`, `write <path> <file>`, `rm <path>`, `reset` (workspace, sessions, saved layout), `snapshot <dir>`. Paths are workspace paths (`pipelines/x.pipe`, `apps/<app>/...`), mapped to the store the same way apps/rocket-ui/src/surfaces/workspace/vfs/workspace.ts does. |

Settings (environment):
- `RR_VERIFY_ENGINE` (`source` or `image`, default source), `RR_VERIFY_IMAGE`, `RR_VERIFY_LAUNCHER`
- `RR_VERIFY_KEYS_DIR`, `RR_VERIFY_NO_KEYS=1`
- `RR_VERIFY_EVIDENCE` (default `<checkout>/.verify/agent`), `RR_VERIFY_STATE` (default `<checkout>/.verify/agent-state`)
- `RR_VERIFY_SHELL_PORT`, `RR_VERIFY_UI_PORT`, `RR_VERIFY_LOCK` (default `/tmp/rr-verify-5565.lock`)
- `RR_VERIFY_APIKEY` (default `local-test`), which verify-rocketride's launcher reads too

## Known limits

- **Engine binary.** Without a matching release or a compile, the source engine's binary is the nearest release's. The build record and `engine.json` say so, with the C++ diff. The engine's Python is always the checkout's.
- **Shared engine data.** Source runs from one checkout share `dist/data` with verify-rocketride runs from that checkout. The file store is separate (see Launch).
- **Teams.** The OSS engine has one team (`local`), so the team switch journey cannot reach its precondition here.
- **Where this skill applies.** It covers the browser agent. Other apps, the VS Code extension and the engine are out of scope; use verify-rocketride for the engine, SDKs, CLIs and MCP.
