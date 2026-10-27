# Browser agent verification map

This directory is the maintained source for verifying the user-facing behavior of the browser agent: the Agent tab of Rocket Builder and the workspace files it changes. Read this index before driving, then use the matching feature file as the recipe. Nothing outside the browser agent belongs here.

## Baseline preconditions

- `rr-verify-agent launch` succeeded and `rr-verify-agent doctor` exits 0 for this checkout, or `rr-verify-agent run` does both.
- The engine on 5565 was started by this checkout's rr-verify-agent, with `ROCKETRIDE_ANTHROPIC_KEY` set (names are in `.verify/agent-state/engine-vars.txt`).
- `.verify/agent-state/engine.json` names the engine. Prefer `--engine source`: on the published image the chat cannot save sessions, so checks that read them report not verifiable.
- Each journey clears the workspace files, agent sessions and the saved workbench layout first (`rr-verify-agent engine reset`), then seeds its own fixtures through the engine. Without the layout reset, open editor and session tabs carry over from the previous journey.
- Never drive an instance this skill did not start.

## Driving conventions

- Every journey opens the app the way a user does. It goes to the shell home, presses `Sign In`, enters the local key on the `API key` screen, then opens `http://127.0.0.1:3000/?appid=rocketride.pipeBuilder&rrdev=1`.
- Prefer ARIA roles and accessible names: tabs `Agent`, `Explorer`, `Pipelines`; buttons `New session`, `Send`; the `Reply to the agent...` textbox.
- The first rail-tab click after the app loads is swallowed while the app restores its default view. Click until the tab reports `aria-selected="true"`.
- Only one composer is visible at a time, even with several session tabs open. Drive the visible one.
- A turn has ended when the typing dots are gone.
- When the agent stops to ask for approval (the building guides gate on node choice, wiring and cost), answer the way a user would: "Yes, approved. Go ahead and build it, and validate it when you are done."

## Proof and skip reporting

- Capture the user action and the resulting state: a screenshot and an ARIA snapshot after each action and each turn end.
- A file change counts only when the file is read back through the engine (`engine-final/`). A pipeline counts only when the engine's validate returns no errors.
- Model-boundary proofs (secrets) use `ws-sent.jsonl`, the frames the page sent.
- Record the journey name and evidence path with every claim.
- An unreachable precondition is a failure with its reason, not a skip and not a pass by another path.
- A check that reads saved sessions is `not-verifiable` on an engine without `fs_put_json`, and the journey's status is `incomplete`, not `pass`. Today those checks are `reply-recorded` (build-pipeline), and `sessions-saved`, `canary-not-in-session`, `canary-not-in-catalog`, `pasted-not-stored` and `midrun-not-stored` (secrets).
- Name the engine with every result (`engine.json`'s `summary`).

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then has exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with rr-verify-agent`, `Gotchas`. Keep implementation details out, except where a gotcha needs one.

## Features

Evidence paths below are relative to the evidence root. Runs from 2026-10-27 on use this skill's default root, `<checkout>/.verify/agent/`. Earlier runs came from the skill's uncommitted predecessor (verify-rocket-agent) and are kept with the PR #2718 notes, outside the repo.

| Feature | PR | Journey | Before (369f0511, 2026-10-24, image) |
|---|---|---|---|
| [Build a pipeline from a prompt](./build-pipeline.md) | baseline for all | `build-pipeline` | Pass. One turn, `verify-chat.pipe` validated. `build-pipeline/2026-10-24T02-19-55-315Z/` |
| [Secrets stay out of the model](./secrets.md) | B1 (B2 not provable here) | `secrets` | Fail, real. The fake key leaves the page inside the model question. `secrets/2026-10-24T02-22-01-969Z/` |
| [Unsaved edits while the agent edits](./unsaved-edits.md) | A1 | `unsaved-edits`, `steps closed-dirty-tab`, `steps split-save` | Fail, real. The agent writes behind the dirty editor without asking. `unsaved-edits/2026-10-24T02-22-23-196Z/` |
| [Turn result and needs you](./turn-result.md) | C | `needs-you` | Fail, real. The missing Variable is named only in reply text. `needs-you/2026-10-24T02-26-49-311Z/` |
| [Team switch mid-run, and stop](./team-switch-and-stop.md) | A (team switch), Dylan's cancel work (stop) | `stop`, `team-switch` | stop: fail, real, no Stop control. team-switch: precondition unmet on the OSS engine. `stop/2026-10-24T02-28-48-463Z/`, `team-switch/2026-10-24T00-21-39-244Z/` |

Driver problems found and fixed while getting these results: the swallowed first rail click, Explorer rows matched outside the side panel, Monaco's non-breaking spaces, the editor header read, and the layout carrying tabs between journeys. None changed a check's pass rule.

Later changes, all kept in the one `drive.mjs`:

- PR B1 (2026-10-24, 2026-10-25): the `secrets` journey checks what the B1 spec's proof lists, not only the frames. The marker is sent, and the fake key is absent from the DOM with thinking groups open, the thinking rows, the saved sessions and the catalog. It pastes a second fake key and checks that it is blocked and never sent or stored, and sends a third while a turn runs. The engine snapshot keeps all fake keys visible. Results are in `secrets.md`.
- PR A1 (2026-10-25, 2026-10-26): `unsaved-edits --choice save|discard|keep` answers every "Unsaved changes" dialog and checks the end state for that answer. The steps runner gained `view`, `openFile`, `wait`, `expectNoText`, `css` and `nth` handles, `waitTurn` with `answer` and `expectDialogs`, and `fixtures/` arguments, for the `closed-dirty-tab` and `split-save` steps files. Results are in `unsaved-edits.md`.
- PR D (2026-10-27): the skill moved to `.agents/skills/rr-verify-agent/` with portable defaults, optional tokenstash, a pinned image, `--engine source` through verify-rocketride's launcher with provenance in every result, the not-verifiable status, and a fixture `package.json` for the `verify-notes` app.

On the bare tip fda7c679, 2026-10-27, with the source engine (`server-v3.5.0` binary, the checkout's engine Python, `fs_put_json` present), Claude Sonnet through the stand-in:

| Journey | Result | Evidence |
|---|---|---|
| `build-pipeline` | Pass, all four checks, `reply-recorded` included. Twice. | `build-pipeline/2026-10-27T05-57-13-351Z/`, `build-pipeline/2026-10-27T06-02-31-032Z/` |
| `stop` | Pass. The tip has Dylan's Stop button. | `stop/2026-10-27T05-58-35-000Z/` |
| `secrets` | Fail, 10 of 14, all B1 behavior. `sessions-saved` passes. | `secrets/2026-10-27T06-04-25-152Z/` |
| `steps closed-dirty-tab` | Fail, `agent-edit-kept` only, A1 behavior. check_app passed on the fixture manifest. | `steps-closed-dirty-tab/2026-10-27T06-05-25-367Z/` |
| `build-pipeline` on the image (fallback) | Incomplete: three pass, `reply-recorded` not verifiable. | `build-pipeline/2026-10-27T06-07-15-724Z/` |

Not run on the tip: `unsaved-edits` and `split-save` (A1, not on the tip), `needs-you` (C, not on the tip), `team-switch` (the OSS engine has one team).
