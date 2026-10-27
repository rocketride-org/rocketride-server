# Build a pipeline from a prompt

A user describes a pipeline in the Agent tab. The agent writes a `.pipe` file into the workspace's `pipelines/` folder, validates it with the engine, and ends its turn with a reply that says what it built and what it checked.

## Sub-features

- `build-new` writes a new `.pipe` under `pipelines/` that the engine validates with no errors.
- `build-approval` handles the guides' approval stops: the user's "yes" lets the build continue.
- `build-reply` ends the turn on its own with a reply that names the file and the check ("Checked: validate OK").
- `build-session` keeps the conversation in the session list so it reopens later.

## How to get to it (user POV)

- Rocket Builder, `Agent` rail tab, `New session`, type a request in `Reply to the agent...`, press `Send`.
- The same from one of the welcome panel's example cards (`Build a pipeline ...`), which sends its prompt on click.

## Driving it with rr-verify-agent

Preconditions:

- `rr-verify-agent doctor` exits 0 and `ROCKETRIDE_ANTHROPIC_KEY` is set on the engine.
- No `pipelines/verify-chat.pipe` exists. The journey clears the workspace first.

- **Open the app and sign in.** Run `rr-verify-agent drive build-pipeline`. `01-app-loaded.png` shows the rail with `Agent`.
- **Start a session.** The journey clicks `New session`. `02-new-session.png` shows the welcome panel and an empty composer.
- **Ask.** It sends "Build a pipeline called verify-chat where I can chat with Claude Sonnet 4.6. My Anthropic key is already in Variables as ROCKETRIDE_ANTHROPIC_KEY." `03-turn1-sent.png` shows the user bubble and the typing dots.
- **Answer approval stops.** If a turn ends with no new `.pipe`, it sends the approval reply, up to 4 times (`--max-followups`).
- **Proof.** The files in `engine-final/workspace/pipelines/` and `validate-verify-chat.pipe.json` with `"errors": []`, the last `turnN-ended.png` showing the reply, and the session JSON in `engine-final/sessions/rocketride.pipeBuilder/`. `result.json` passes on four checks: `turn-ended`, `pipeline-written`, `engine-validate` and `reply-recorded`. `reply-recorded` reads the saved session, so it needs an engine with `fs_put_json` (`--engine source`); on the published image it is not verifiable and the journey is `incomplete`.
- **Other prompts.** `rr-verify-agent drive build-pipeline --prompt "<request>"` runs the same checks on another request.

Proven on the bare tip fda7c679 with the source engine (`fs_put_json` present), 2026-10-27, twice: all four checks pass, `reply-recorded` included. Each run took one turn (76 s, then 109 s), validated `pipelines/verify-chat.pipe` with no errors, and saved the session and the catalog. Evidence: `build-pipeline/2026-10-27T05-57-13-351Z/` and `build-pipeline/2026-10-27T06-02-31-032Z/`.

The fallback, on the same tip: with the launcher path pointed at nothing, launch said it could not start the engine from source and used the image. The probe got `Unknown subcommand: fs_put_json`. Three checks passed, `reply-recorded` was not verifiable, and the journey ended `incomplete` (exit 3). Evidence: `build-pipeline/2026-10-27T06-07-15-724Z/`.

Proven on 369f0511 with Claude Sonnet through the stand-in, 2026-10-24, twice. The latest run, on the final driver: one turn, 118 s, `pipelines/verify-chat.pipe` validated with no errors, and the reply ends "Checked: validate OK". Evidence: `build-pipeline/2026-10-24T02-19-55-315Z/`. The first proof: `build-pipeline/2026-10-24T00-17-18-717Z/`.

## Gotchas

- Opening the app URL in a fresh tab first leaves it at "Initialising... Rocket Builder" with no sign-in screen. The shell's sign-in gate needs the app's manifest entry. Sign in from the shell home first, then open the app URL. The journey does this.
- On load the app opens a `New session` editor tab by itself, so there are two composers after clicking `New session`. Only the visible one is the active session.
- The app saves its open tabs in `.workspace/rocketride.pipeBuilder.workspace.json` on the engine. `rr-verify-agent engine reset` clears it, so each journey starts with only those two tabs.
- The typing indicator has no ARIA handle. The journey matches its inline animation `rr-chat-dot`, which breaks if the style changes. `data-testid="chat-typing"` would fix that.
- The reply text alone is not proof. The model can say "validated" when it did not. The journey checks the file and runs validate itself.
- The guides also tell the model to write `.context/GATE_STATE.md`. The workspace refuses paths outside `apps/`, `nodes/` and `pipelines/`, so that write fails on every approval stop. It shows in the thinking rows and does not fail the journey.
- From c560a80e (2026-10-25) on, `reply-recorded` fails on the published image whatever the branch. Commit 9bd5d931 made `fsWriteJson` send `fs_put_json`, which only the branch's engine has, and the console logs `session save failed Error: Unknown subcommand: fs_put_json`. The skill now reports it as not verifiable there. The other three checks still work on the image.
- A turn can take several minutes. The default turn timeout is 20 minutes (`--turn-timeout-min`).
